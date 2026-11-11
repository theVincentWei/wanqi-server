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
import 'provisioner.dart';
import 'store.dart';

class BundleService {
  BundleService(this.cfg, this.db, this.store, this.market, this.gateway,
      this.provisioner);

  final AppConfig cfg;
  final Db db;
  final Store store;
  final Market market;
  final Gateway gateway;
  final Provisioner provisioner;

  shelf_router.Router get router {
    final router = shelf_router.Router()
      ..post('/api/v1/bundle/install', _install)
      ..get('/api/v1/bundle', _statusAll)
      ..get('/api/v1/bundle/<appId>', _status)
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
      autoSync: manifest.autoSync,
      actor: 'bundle',
      action: 'bundle.install',
    );

    // ③ unpack + ④ spawn (provisioned). The old process is stopped before
    // the code dir rotates; a failed health gate rolls the code dirs back to
    // previous and restarts it — "失败报错、保留旧版" (§5④/§6).
    int unpackedBytes = 0;
    int? livePort;
    if (manifest.backend != null) {
      await provisioner.stop(manifest.appId);
      final BackendPaths paths = _paths(manifest.appId);
      final bool hadPrevious = paths.hasPrevious;
      try {
        unpackedBytes = await installBackendDir(
            archive: archive, manifest: manifest, backendsRoot: cfg.backendsDir);
      } on BackendFsException catch (error) {
        return _err(500, 'backend unpack failed: $error');
      }
      final StartResult started =
          await provisioner.start(manifest.appId, manifest);
      if (started.ok) {
        livePort = started.port;
      } else {
        final String message =
            'backend start failed: ${started.error}';
        if (hadPrevious) {
          await rollbackBackendDir(paths);
          final BundleManifest? previous = _manifestAt(paths.current);
          if (previous != null) {
            final StartResult restored =
                await provisioner.start(manifest.appId, previous);
            if (!restored.ok) {
              await _registerPlaceholders(
                  manifest.appId,
                  previous.backend?.gateway ?? const <String>[]);
            }
            await db.audit('bundle', 'bundle.install-rollback',
                '${manifest.appId} v${manifest.versionCode} failed health; '
                'previous v${previous.versionCode} restored');
            return _json(<String, Object?>{
              'error': message,
              'rolledBackTo': previous.versionCode,
              'appId': manifest.appId,
              'versionCode': previous.versionCode,
            }, 500);
          }
        }
        await _registerPlaceholders(manifest.appId, manifest.backend!.gateway);
        await db.audit('bundle', 'bundle.install',
            '${manifest.appId} v${manifest.versionCode} start failed');
        return _json(<String, Object?>{
          'error': message,
          'appId': manifest.appId,
          'versionCode': manifest.versionCode,
        }, 500);
      }
    } else {
      // Pure frontend: a stale backend instance (if any) must not survive a
      // backend-less upgrade.
      await provisioner.stop(manifest.appId);
    }

    // ⑤ routes: table state becomes exactly the declared gateway list. A
    // live spawn already wrote the real targets; otherwise placeholders
    // (task-4's spawn rewrites them, so a fresh install without a running
    // backend — e.g. restore skipped — still records the declaration).
    final List<String> prefixes =
        manifest.backend?.gateway ?? const <String>[];
    if (livePort == null) {
      await store.deleteRoutesForApp(manifest.appId);
      for (final String prefix in prefixes) {
        await store.upsertRoute(
            manifest.appId, prefix, bundleRoutePlaceholder, 5000, 120);
      }
      await gateway.reload();
      await db.audit('bundle', 'bundle.routes',
          '${manifest.appId} → $prefixes (placeholder targets)');
    }

    return _json(<String, Object?>{
      ...published,
      'backend': manifest.backend != null,
      'autoSync': manifest.autoSync,
      'routes': prefixes,
      if (livePort != null) 'port': livePort,
      if (manifest.backend != null)
        'backendStart': manifest.backend!.start,
      'unpackedBytes': unpackedBytes,
    });
  }

  /// Parses the bundle.json inside a code dir; null when unreadable.
  BundleManifest? _manifestAt(String dir) {
    try {
      return BundleManifest.parse(
          jsonDecode(File(p.join(dir, 'bundle.json')).readAsStringSync()));
    } catch (_) {
      return null;
    }
  }

  Future<void> _registerPlaceholders(
      String appId, List<String> prefixes) async {
    await store.deleteRoutesForApp(appId);
    for (final String prefix in prefixes) {
      await store.upsertRoute(appId, prefix, bundleRoutePlaceholder, 5000, 120);
    }
    await gateway.reload();
  }

  /// POST /api/v1/bundle/<appId>/rollback — Bundle-level rollback (§6, with
  /// §1 "一个 Bundle 一个版本号" semantics): the market rows re-point at the
  /// previous version (versionCode truly goes back), and the backend half is
  /// re-derived from the donor zip itself so market/code/routes can never
  /// diverge. Pure-frontend donors (or legacy pre-bundle zips) simply have no
  /// backend half — no 409 for missing backend dirs.
  Future<shelf.Response> _rollback(shelf.Request request, String appId) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');
    if (!isValidAppId(appId)) return _err(400, 'invalid appId');
    final latest = await store.latestVersion(appId);
    if (latest == null) return _err(404, 'no such app');
    final donor = await store.versionBelow(appId, latest['version_code'] as int);
    if (donor == null) return _err(409, 'only one version — nothing to roll back to');
    final int donorCode = donor['version_code'] as int;
    final File donorZip = File(cfg.packagePath(appId, donorCode));
    if (!await donorZip.exists()) {
      return _err(500, 'donor package file missing: ${p.basename(donorZip.path)}');
    }

    // Whatever is running goes down before anything moves.
    await provisioner.stop(appId);

    // Market: drop newer rows — latest is now the donor, versionCode truly
    // reverted. The newer zips stay on disk (a re-upgrade re-inserts them).
    await store.deleteVersionsAbove(appId, donorCode);

    // Backend: re-derive from the donor zip (the same bytes the market now
    // serves — single source of truth).
    final Archive donorArchive;
    try {
      donorArchive = ZipDecoder()
          .decodeBytes(await donorZip.readAsBytes(), verify: true);
    } catch (_) {
      return _err(500, 'donor package ${p.basename(donorZip.path)} is not a zip');
    }
    final ArchiveFile? manifestEntry = bundleEntry(donorArchive, 'bundle.json');
    BundleManifest? donorManifest;
    if (manifestEntry != null) {
      try {
        donorManifest = BundleManifest.parse(jsonDecode(utf8.decode(
            Uint8List.fromList(manifestEntry.content as List<int>),
            allowMalformed: true)));
      } catch (_) {
        donorManifest = null; // legacy/unreadable manifest → frontend-only
      }
    }
    final List<String> prefixes;
    int? livePort;
    if (donorManifest?.backend != null) {
      final BundleManifest manifest = donorManifest!;
      try {
        await installBackendDir(
            archive: donorArchive, manifest: manifest, backendsRoot: cfg.backendsDir);
      } on BackendFsException catch (error) {
        return _err(500, 'rollback: backend unpack failed: $error');
      }
      final StartResult started = await provisioner.start(appId, manifest);
      prefixes = manifest.backend!.gateway;
      if (!started.ok) {
        await _registerPlaceholders(appId, prefixes);
        await db.audit('bundle', 'bundle.rollback',
            '$appId -> v$donorCode but start failed');
        return _json(<String, Object?>{
          'error': 'rollback: backend start failed: ${started.error}',
          'appId': appId,
          'versionCode': donorCode,
          'routes': prefixes,
        }, 500);
      }
      livePort = started.port;
      await store.upsertApp(appId, manifest.name, manifest.frontendEntry,
          backend: true, autoSync: manifest.autoSync);
    } else {
      // Frontend-only donor (or legacy zip without bundle.json): the backend
      // half goes away entirely — code dirs deleted, data/logs/DB kept.
      await removeBackendDirs(_paths(appId));
      await store.deleteRoutesForApp(appId);
      await gateway.reload();
      prefixes = const <String>[];
      if (donorManifest != null) {
        await store.upsertApp(appId, donorManifest.name, donorManifest.frontendEntry,
            backend: false, autoSync: donorManifest.autoSync);
      } else {
        await store.setAppBackend(appId, false);
      }
    }

    await db.audit('bundle', 'bundle.rollback',
        '$appId -> v$donorCode routes=$prefixes');
    return _json(<String, Object?>{
      'appId': appId,
      'versionCode': donorCode,
      'versionName': donor['version_name'],
      'routes': prefixes,
      if (livePort != null) 'port': livePort,
    });
  }

  /// DELETE /api/v1/bundle/<appId>[?purge=1] — §6 remove: stop the process,
  /// de-register routes, drop code dirs and market rows; data/, logs/ and the
  /// per-app DB schema are preserved so reinstalling picks up where it left
  /// off (and the version gate starts fresh — remove+install keeps
  /// versionCode).
  ///
  /// `?purge=1`(手机端卸载接整包语义,§6 用户勾选「同时清除主机数据」)在
  /// 保留集之外追加清空:**DROP schema + 删账号、data/logs 整目录、packages
  /// 里的 zip/icon/shots 分片、app_tokens、该 app 的通知行**(模板/订阅/
  /// 通知对象/应用级开关)。purge 闭集到此为止——install_events 与 audit_log
  /// 历史保留。各步 best-effort,任一残留不阻断卸载主流程。
  Future<shelf.Response> _remove(shelf.Request request, String appId) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');
    if (!isValidAppId(appId)) return _err(400, 'invalid appId');
    if (await store.latestVersion(appId) == null) {
      return _err(404, 'no such app');
    }
    final String purgeRaw = request.url.queryParameters['purge'] ?? '';
    final bool purge = purgeRaw == '1' || purgeRaw == 'true';
    await provisioner.stop(appId);

    final BackendPaths paths = _paths(appId);
    final bool hadData = paths.exists;
    int packageFiles = 0;
    bool schemaDropped = false;
    if (purge) {
      // data/logs 与代码目录一起清(整包语义:用户显式勾选了清除主机数据)。
      if (paths.exists) {
        try {
          await Directory(paths.root)
              .delete(recursive: true)
              .timeout(const Duration(seconds: 30));
        } catch (error) {
          stdout.writeln('bundle: purge delete ${paths.root} failed: $error');
        }
      }
      // packages/ 分片与 icon/shots:<appId>-<code>.zip、-icon.png、-shot-N.png
      try {
        final Directory packages = Directory(cfg.packagesDir);
        if (await packages.exists()) {
          await for (final FileSystemEntity entry in packages.list()) {
            if (p.basename(entry.path).startsWith('$appId-')) {
              await entry.delete();
              packageFiles += 1;
            }
          }
        }
      } catch (error) {
        stdout.writeln('bundle: purge packages $appId failed: $error');
      }
      schemaDropped = await store.dropAppDb(appId);
      await store.purgeAppTokens(appId);
      await store.purgeNotifyRows(appId);
      await db.audit('bundle', 'bundle.remove',
          '$appId purge=true (schema=$schemaDropped packageFiles=$packageFiles)');
    }

    // 公共清理(默认与 purge 共用):停后端已做、撤路由、删代码目录与市场行。
    if (!purge) {
      await removeBackendDirs(paths);
    }
    await store.deleteRoutesForApp(appId);
    await gateway.reload();
    await store.deleteApp(appId);
    if (purge) {
      return _json(<String, Object?>{
        'appId': appId,
        'removed': true,
        'purged': true,
        'schemaDropped': schemaDropped,
        'packageFilesDeleted': packageFiles,
      });
    }
    await db.audit('bundle', 'bundle.remove',
        '$appId (data/logs/DB kept: $hadData)');
    return _json(<String, Object?>{
      'appId': appId,
      'removed': true,
      'purged': false,
      'dataKept': hadData,
    });
  }

  /// GET /api/v1/bundle — every supervised backend (ops / acceptance).
  Future<shelf.Response> _statusAll(shelf.Request request) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');
    return _json(<String, Object?>{'instances': provisioner.statusAll()});
  }

  /// GET /api/v1/bundle/<appId> — one backend's supervision state.
  Future<shelf.Response> _status(shelf.Request request, String appId) async {
    if (!_publisher(request)) return _err(401, 'unauthorized');
    if (!isValidAppId(appId)) return _err(400, 'invalid appId');
    final Map<String, Object?>? state = provisioner.status(appId);
    if (state == null) {
      return _err(404, 'no supervised backend for $appId');
    }
    return _json(state);
  }
}
