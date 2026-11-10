/// Bundle v1 lifecycle endpoints (spec §5/§6, step 1 — provisioning/spawn is
/// task-4):
///
///   POST   /api/v1/bundle/install            raw zip body → gate → market row
///                                            → unpack backend/ → auto routes
///   POST   /api/v1/bundle/<appId>/rollback   current/ ↔ previous/, re-routes
///   DELETE /api/v1/bundle/<appId>            uninstall: stop-routes, drop
///                                            market rows + code dirs; data/
///                                            logs/DB always survive
///
/// The route table state after install is exactly bundle.json's gateway
/// list — this retires manual `route add` for bundle apps (§5⑤). Targets are
/// the placeholder [bundleRoutePlaceholder] until task-4 assigns a dynamic
/// port at spawn.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;
import 'package:shelf/shelf.dart' as shelf;
import 'package:shelf_router/shelf_router.dart' as shelf_router;

import 'bundle.dart';
import 'bundle_fs.dart';
import 'config.dart';
import 'db.dart';
import 'gateway.dart';
import 'market.dart';
import 'store.dart';

class BundleService {
  BundleService(this.cfg, this.db, this.store, this.market, this.gateway);

  final AppConfig cfg;
  final Db db;
  final Store store;
  final Market market;
  final Gateway gateway;

  shelf_router.Router get router {
    final router = shelf_router.Router()
      ..post('/api/v1/bundle/install', _install)
      ..post('/api/v1/bundle/<appId>/rollback', _rollback)
      ..delete('/api/v1/bundle/<appId>', _remove);
    return router;
  }

  bool _publisher(shelf.Request request) {
    final String key = cfg.publisherKey;
    return key.isNotEmpty &&
        (request.headers['authorization'] ?? '') == 'Bearer $key';
  }

  shelf.Response _json(Object? body, [int status = 200]) => shelf.Response(
      status,
      body: jsonEncode(body),
      headers: <String, String>{'content-type': 'application/json; charset=utf-8'});

  shelf.Response _err(int status, String message) => _json(
      <String, Object?>{'error': message}, status);

  BackendPaths _paths(String appId) =>
      BackendPaths(p.join(cfg.backendsDir, appId));

  /// POST /api/v1/bundle/install — spec §5, steps ①②③⑤ (④ spawn is task-4).
  /// Covers first install and upgrade: the versionCode gate enforces strict
  /// increase against the market's latest (§5①), and the previous code dir
  /// is preserved for rollback (§6).
  Future<shelf.Response> _install(shelf.Request request) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');

    final List<int> bytes = await request
        .read()
        .fold<BytesBuilder>(BytesBuilder(), (b, chunk) => b..add(chunk))
        .then((b) => b.takeBytes());
    if (bytes.isEmpty) return _err(400, 'empty body');

    final Archive archive;
    try {
      archive = ZipDecoder().decodeBytes(bytes, verify: true);
    } catch (_) {
      return _err(400, 'body is not a zip');
    }

    // The appId only becomes known by reading bundle.json, so do a raw read
    // here for the version-gate lookup; the strict gate below produces the
    // precise rejection for any malformed manifest.
    final ArchiveFile? manifestEntry = bundleEntry(archive, 'bundle.json');
    if (manifestEntry == null) {
      return _err(400,
          'bundle.json missing at zip root — old-format packages are rejected');
    }
    String? rawAppId;
    try {
      final Object? decoded = jsonDecode(utf8.decode(
          Uint8List.fromList(manifestEntry.content as List<int>),
          allowMalformed: true));
      rawAppId = decoded is Map<String, Object?> ? decoded['appId'] as String? : null;
    } catch (_) {
      rawAppId = null;
    }
    Map<String, Object?>? latest;
    int? latestCode;
    if (rawAppId != null && isValidAppId(rawAppId)) {
      latest = await store.latestVersion(rawAppId);
      latestCode = latest == null ? null : latest['version_code'] as int?;
    }

    final BundleGateResult gate =
        gateBundle(archive, zipBytes: bytes.length, latestVersionCode: latestCode);
    if (gate.rejected || gate.manifest == null) {
      return _err(gate.statusCode, gate.error ?? 'bundle rejected');
    }
    final BundleManifest manifest = gate.manifest!;

    // ② market row (publish path unchanged underneath)
    final Map<String, Object?> published = await market.publishVersion(
      archive: archive,
      bytes: bytes,
      appId: manifest.appId,
      name: manifest.name,
      path: manifest.frontendEntry,
      versionCode: manifest.versionCode,
      versionName: manifest.versionName,
      latest: latest,
      backend: manifest.backend != null,
      actor: 'bundle',
      action: 'bundle.install',
    );

    // ③ unpack backend/ → backends/<appId>/current (previous kept)
    int unpackedBytes = 0;
    if (manifest.backend != null) {
      try {
        unpackedBytes = await installBackendDir(
            archive: archive, manifest: manifest, backendsRoot: cfg.backendsDir);
      } on BackendFsException catch (error) {
        return _err(500, 'backend unpack failed: $error');
      }
    }

    // ⑤ routes: table state becomes exactly the declared gateway list.
    final List<String> prefixes =
        manifest.backend?.gateway ?? const <String>[];
    await store.deleteRoutesForApp(manifest.appId);
    for (final String prefix in prefixes) {
      await store.upsertRoute(
          manifest.appId, prefix, bundleRoutePlaceholder, 5000, 120);
    }
    await gateway.reload();
    await db.audit('bundle', 'bundle.routes',
        '${manifest.appId} → $prefixes (placeholder targets)');

    return _json(<String, Object?>{
      ...published,
      'backend': manifest.backend != null,
      'routes': prefixes,
      if (manifest.backend != null)
        'backendStart': manifest.backend!.start,
      'unpackedBytes': unpackedBytes,
    });
  }

  /// POST /api/v1/bundle/<appId>/rollback — §6: swap current/ ↔ previous/,
  /// then re-register routes from the previous dir's bundle.json. The market
  /// row stays on the newest frontend version (frontend rollback keeps using
  /// the existing version-bump rollback; v1 scope per spec).
  Future<shelf.Response> _rollback(shelf.Request request, String appId) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');
    if (!isValidAppId(appId)) return _err(400, 'invalid appId');
    if (await store.latestVersion(appId) == null) {
      return _err(404, 'no such app');
    }
    final BackendPaths paths = _paths(appId);
    try {
      await rollbackBackendDir(paths);
    } on BackendFsException catch (error) {
      return _err(409, error.message);
    }

    // Re-register exactly the previous manifest's gateway list.
    final File previousManifest = File(p.join(paths.current, 'bundle.json'));
    List<String> prefixes = const <String>[];
    int? rolledBackCode;
    if (await previousManifest.exists()) {
      try {
        final BundleManifest manifest = BundleManifest.parse(jsonDecode(
            await previousManifest.readAsString()));
        prefixes = manifest.backend?.gateway ?? const <String>[];
        rolledBackCode = manifest.versionCode;
      } catch (_) {
        return _err(500,
            'rollback swapped dirs but previous/bundle.json is unreadable; routes untouched');
      }
      await store.deleteRoutesForApp(appId);
      for (final String prefix in prefixes) {
        await store.upsertRoute(
            appId, prefix, bundleRoutePlaceholder, 5000, 120);
      }
      await gateway.reload();
    }
    await db.audit('bundle', 'bundle.rollback',
        '$appId -> v$rolledBackCode routes=$prefixes');
    return _json(<String, Object?>{
      'appId': appId,
      'versionCode': rolledBackCode,
      'routes': prefixes,
    });
  }

  /// DELETE /api/v1/bundle/<appId> — §6 remove: de-register routes, drop
  /// code dirs and market rows. data/, logs/ and the per-app DB schema are
  /// preserved so reinstalling the same bundle picks up where it left off
  /// (and the version gate starts fresh — remove+install keeps versionCode).
  Future<shelf.Response> _remove(shelf.Request request, String appId) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');
    if (!isValidAppId(appId)) return _err(400, 'invalid appId');
    if (await store.latestVersion(appId) == null) {
      return _err(404, 'no such app');
    }

    final BackendPaths paths = _paths(appId);
    final bool hadData = paths.exists;
    await removeBackendDirs(paths);

    await store.deleteRoutesForApp(appId);
    await gateway.reload();
    await store.deleteApp(appId);
    await db.audit('bundle', 'bundle.remove',
        '$appId (data/logs/DB kept: $hadData)');
    return _json(<String, Object?>{
      'appId': appId,
      'removed': true,
      'dataKept': hadData,
    });
  }
}
