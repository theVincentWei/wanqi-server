// BundleService integration tests — full install/upgrade/rollback/remove
// against a throwaway MariaDB database (wanqi_server_test) and temp dirs.
// No server process: the handlers are invoked directly, like the endpoint
// router would. Skips (not fails) when the local DB is unreachable.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:apphub/bundle_service.dart';
import 'package:apphub/config.dart';
import 'package:apphub/db.dart';
import 'package:apphub/gateway.dart';
import 'package:apphub/market.dart';
import 'package:apphub/provisioner.dart';
import 'package:apphub/store.dart';
import 'package:archive/archive.dart';
import 'package:http/http.dart' as http;
import 'package:mysql1/mysql1.dart' show ConnectionSettings;
import 'package:path/path.dart' as p;
import 'package:shelf/shelf.dart' as shelf;
import 'package:test/test.dart';

const String testDbName = 'wanqi_server_test';
const String appId = 'wanqi-test-svc';
const String key = 'test-key';

// The daemon script installed with backend bundles; [code] marks the bundle
// version so tests can verify WHICH build is serving after a rollback.
String daemonScript(int code) => '''
const http = require('http');
const V = $code;
const port = parseInt(process.env.APPHUB_PORT || '0', 10);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify({v: V, app: process.env.APPHUB_APP_ID, url: req.url}));
});
server.listen(port, '127.0.0.1');
''';

Archive bundleArchive({
  required int code,
  bool backend = false,
}) {
  final Archive archive = Archive();
  void add(String name, String content) {
    final List<int> bytes = utf8.encode(content);
    archive.addFile(ArchiveFile(name, bytes.length, bytes));
  }

  add(
      'bundle.json',
      jsonEncode(<String, Object?>{
        'spec': 1,
        'appId': appId,
        'name': 'svc 测试应用',
        'version': <String, Object?>{'code': code, 'name': '1.$code.0'},
        'frontend': <String, Object?>{'entry': 'pages/index/index'},
        if (backend)
          'backend': <String, Object?>{
            'start': 'node daemon.js',
            'health': '/healthz',
            'gateway': <String>['/'],
          },
      }));
  add('main/app-config.json', '{"app":{"pages":["pages/index/index"]}}');
  add('main/logic.js', 'console.log($code)');
  if (backend) add('backend/daemon.js', daemonScript(code));
  return archive;
}

Uint8List zipBytes(Archive archive) =>
    Uint8List.fromList(ZipEncoder().encode(archive)!);

shelf.Request zipRequest(String path, Uint8List bytes) => shelf.Request(
      'POST',
      Uri.parse('http://svc.test$path'),
      headers: <String, String>{
        'authorization': 'Bearer $key',
        'content-type': 'application/zip',
      },
      body: Stream<List<int>>.value(bytes),
    );

shelf.Request authedRequest(String method, String path) => shelf.Request(
      method,
      Uri.parse('http://svc.test$path'),
      headers: <String, String>{'authorization': 'Bearer $key'},
    );

Future<Map<String, Object?>> bodyJson(shelf.Response response) async =>
    jsonDecode(await response.readAsString()) as Map<String, Object?>;

void main() {
  late Directory dataDir;
  late Directory backendsDir;
  late Db db;
  late Store store;
  late Market market;
  late Gateway gateway;
  late Provisioner provisioner;
  late BundleService service;
  late AppConfig cfg;

  setUp(() async {
    dataDir = await Directory.systemTemp.createTemp('wanqi-svc-data-');
    backendsDir = await Directory.systemTemp.createTemp('wanqi-svc-backends-');
    cfg = AppConfig(
      port: 0,
      db: DbConfig(
        host: '127.0.0.1',
        port: 3306,
        user: 'apphub',
        password: 'apphub-local',
        database: testDbName,
      ),
      publisherKey: key,
      deviceToken: '',
      dataDir: dataDir.path,
      backendsDir: backendsDir.path,
      engineAppsDir: p.join(dataDir.path, 'apps'),
      appDbPassword: 'svc-test-app-pw',
      engineLaunchUrl: '',
      engineLaunchUrlFile: '',
    );
    final Db bootstrap = Db(ConnectionSettings(
        host: '127.0.0.1', port: 3306, user: 'apphub', password: 'apphub-local'));
    try {
      await bootstrap.connect();
    } catch (_) {
      await bootstrap.close();
      markTestSkipped('local MariaDB unavailable — integration suite skipped');
      return;
    }
    await bootstrap.exec('DROP DATABASE IF EXISTS `$testDbName`');
    await bootstrap.exec('CREATE DATABASE `$testDbName` CHARACTER SET utf8mb4');
    await bootstrap.close();

    db = Db(ConnectionSettings(
        host: '127.0.0.1',
        port: 3306,
        user: 'apphub',
        password: 'apphub-local',
        db: testDbName));
    await db.connect();
    await db.initSchema();
    store = Store(db);
    market = Market(cfg, db, store);
    gateway = Gateway(cfg, db, store);
    provisioner = Provisioner(cfg, db, store, gateway, http.Client());
    service = BundleService(cfg, db, store, market, gateway, provisioner);
    await gateway.reload();
  });

  tearDown(() async {
    try {
      await provisioner.stop(appId);
    } catch (_) {}
    try {
      await db.exec('DROP DATABASE IF EXISTS `app_$appId`');
      await db.exec("DROP USER IF EXISTS 'app_$appId'@'localhost'");
    } catch (_) {}
    try {
      await db.close();
    } catch (_) {}
    if (await dataDir.exists()) await dataDir.delete(recursive: true);
    if (await backendsDir.exists()) await backendsDir.delete(recursive: true);
  });

  tearDownAll(() async {
    try {
      final Db cleanup = Db(ConnectionSettings(
          host: '127.0.0.1', port: 3306, user: 'apphub', password: 'apphub-local'));
      await cleanup.connect();
      await cleanup.exec('DROP DATABASE IF EXISTS `$testDbName`');
      await cleanup.close();
    } catch (_) {}
  });

  test('install → upgrade → rollback(纯前端) 回指 v1,无 409', () async {
    final shelf.Response install = await service.router
        .call(zipRequest('/api/v1/bundle/install', zipBytes(bundleArchive(code: 1))));
    expect(install.statusCode, 200);

    final shelf.Response upgrade = await service.router
        .call(zipRequest('/api/v1/bundle/install', zipBytes(bundleArchive(code: 2))));
    expect(upgrade.statusCode, 200);
    expect((await store.latestVersion(appId))?['version_code'], 2);

    final shelf.Response rollback =
        await service.router.call(authedRequest('POST', '/api/v1/bundle/$appId/rollback'));
    expect(rollback.statusCode, 200);
    final Map<String, Object?> body = await bodyJson(rollback);
    expect(body['versionCode'], 1);

    // ① market row re-pointed
    final Map<String, Object?>? latest = await store.latestVersion(appId);
    expect(latest?['version_code'], 1);
    expect(latest?['version_name'], '1.1.0');
    // ② the downloadable zip is the v1 bytes, sha256 consistent
    final File v1zip = File(cfg.packagePath(appId, 1));
    expect(await v1zip.exists(), isTrue);
    final List<int> bytes = await v1zip.readAsBytes();
    expect(bytes, zipBytes(bundleArchive(code: 1)));
    expect(latest?['sha256'], isNotNull);
    // newer version's zip remains on disk (harmless orphan)
    expect(await File(cfg.packagePath(appId, 2)).exists(), isTrue);
    // no backend involved anywhere
    expect(Directory(p.join(backendsDir.path, appId)).existsSync(), isFalse);
    expect((await store.listRoutes()).where((r) => r['appId'] == appId), isEmpty);
  });

  test('rollback on a single-version app → 409 only-one-version', () async {
    final shelf.Response install = await service.router
        .call(zipRequest('/api/v1/bundle/install', zipBytes(bundleArchive(code: 5))));
    expect(install.statusCode, 200);
    final shelf.Response rollback =
        await service.router.call(authedRequest('POST', '/api/v1/bundle/$appId/rollback'));
    expect(rollback.statusCode, 409);
    expect((await bodyJson(rollback))['error'], contains('only one version'));
  });

  test('install backend → spawned, health 200, routes real port', () async {
    final shelf.Response install = await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 3, backend: true))));
    expect(install.statusCode, 200);
    final Map<String, Object?> body = await bodyJson(install);
    final int? port = body['port'] as int?;
    expect(port, isNotNull);
    expect(provisioner.isRunning(appId), isTrue);

    final List<Map<String, Object?>> routes = await store.listRoutes();
    expect(routes, hasLength(1));
    expect(routes.single['target'], 'http://127.0.0.1:$port');

    // the gateway would reach the daemon — verify the upstream directly
    final http.Response health = await http
        .get(Uri.parse('http://127.0.0.1:$port/healthz'))
        .timeout(const Duration(seconds: 3));
    expect(health.statusCode, 200);
    // market flag on
    final Map<String, Object?>? latest = await store.latestVersion(appId);
    expect(latest?['version_code'], 3);
  });

  test('rollback with backend → previous version respawned and serving',
      () async {
    await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 3, backend: true))));
    await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 4, backend: true))));
    expect((await store.latestVersion(appId))?['version_code'], 4);

    final shelf.Response rollback =
        await service.router.call(authedRequest('POST', '/api/v1/bundle/$appId/rollback'));
    expect(rollback.statusCode, 200);
    final Map<String, Object?> body = await bodyJson(rollback);
    expect(body['versionCode'], 3);

    // market re-pointed
    expect((await store.latestVersion(appId))?['version_code'], 3);
    // a fresh daemon serves the v3 build through the (re-pointed) route
    final Map<String, Object?>? status = provisioner.status(appId);
    expect(status?['running'], isTrue);
    final int? port = status?['port'] as int?;
    final http.Response stats = await http
        .get(Uri.parse('http://127.0.0.1:$port/stats'))
        .timeout(const Duration(seconds: 3));
    final Map<String, Object?> served = jsonDecode(stats.body) as Map<String, Object?>;
    expect(served['v'], 3);
    final List<Map<String, Object?>> routes = await store.listRoutes();
    expect(routes.single['target'], 'http://127.0.0.1:$port');
  });

  test('kill daemon → supervised respawn (3s 验收线)', () async {
    await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 1, backend: true))));
    final int oldPid = provisioner.status(appId)?['pid'] as int;
    Process.killPid(oldPid, ProcessSignal.sigkill);

    // Poll until the supervisor has respawned AND the fresh daemon answers
    // health 200 (running flips true before the process binds its port).
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 6));
    bool backUp = false;
    while (DateTime.now().isBefore(deadline)) {
      final Map<String, Object?>? status = provisioner.status(appId);
      final int? port = status?['port'] as int?;
      if (status?['running'] == true &&
          (status?['restarts'] as int? ?? 0) >= 1 &&
          (status?['pid'] as int?) != oldPid &&
          port != null) {
        try {
          final http.Response health = await http
              .get(Uri.parse('http://127.0.0.1:$port/healthz'))
              .timeout(const Duration(seconds: 2));
          if (health.statusCode == 200) {
            backUp = true;
            break;
          }
        } catch (_) {
          // fresh daemon not binding yet — keep polling
        }
      }
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    expect(backUp, isTrue, reason: 'daemon must be re-spawned by the supervisor');
    // respawn re-owns the route target
    final int? port = provisioner.status(appId)?['port'] as int?;
    final http.Response health = await http
        .get(Uri.parse('http://127.0.0.1:$port/healthz'))
        .timeout(const Duration(seconds: 3));
    expect(health.statusCode, 200);
  });

  test('remove → market rows + routes gone, process stopped, data/logs kept',
      () async {
    await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 1, backend: true))));
    expect(provisioner.isRunning(appId), isTrue);
    final File dataMarker =
        File(p.join(backendsDir.path, appId, 'data', 'state.json'));
    await dataMarker.writeAsString('{"hp":100}');

    final shelf.Response remove =
        await service.router.call(authedRequest('DELETE', '/api/v1/bundle/$appId'));
    expect(remove.statusCode, 200);
    expect(provisioner.isRunning(appId), isFalse);
    expect(await store.latestVersion(appId), isNull);
    expect(await store.listRoutes(), isEmpty);
    expect(await dataMarker.exists(), isTrue);
    expect(Directory(p.join(backendsDir.path, appId, 'logs')).existsSync(), isTrue);
    // reinstall after remove keeps the version number (gate reset)
    final shelf.Response reinstall = await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 1, backend: true))));
    expect(reinstall.statusCode, 200);
  });
}
