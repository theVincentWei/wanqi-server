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
import 'package:apphub/notify_logic.dart' show templateIdFor;
import 'package:apphub/notify_store.dart' show NotifyStore;
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
  late NotifyStore notifyStore;
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
    notifyStore = NotifyStore(db);
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
    // 两个版本的 zip 都先建好再装:ZipEncoder 会嵌当前时间戳,装完再重建
    // 逐字节比对会跨秒失配(flaky)。
    final Uint8List v1bytes = zipBytes(bundleArchive(code: 1));
    final Uint8List v2bytes = zipBytes(bundleArchive(code: 2));
    final shelf.Response install =
        await service.router.call(zipRequest('/api/v1/bundle/install', v1bytes));
    expect(install.statusCode, 200);

    final shelf.Response upgrade =
        await service.router.call(zipRequest('/api/v1/bundle/install', v2bytes));
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
    expect(await v1zip.readAsBytes(), v1bytes);
    expect(latest?['sha256'], isNotNull);
    // newer version's zip remains on disk (harmless orphan)
    expect(await File(cfg.packagePath(appId, 2)).exists(), isTrue);
    expect(await File(cfg.packagePath(appId, 2)).readAsBytes(), v2bytes);
    // no backend involved anywhere
    expect(Directory(p.join(backendsDir.path, appId)).existsSync(), isFalse);
    expect((await store.listRoutes()).where((r) => r['appId'] == appId), isEmpty);
  });

  test('autoSync:bundle.json 顶层字段 → 市场行/manifest/install 响应透传', () async {
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
          'version': <String, Object?>{'code': 1, 'name': '1.1.0'},
          'frontend': <String, Object?>{'entry': 'pages/index/index'},
          'autoSync': true,
        }));
    add('main/app-config.json', '{"app":{"pages":["pages/index/index"]}}');
    add('main/logic.js', 'console.log(1)');

    final shelf.Response install =
        await service.router.call(zipRequest('/api/v1/bundle/install', zipBytes(archive)));
    expect(install.statusCode, 200);
    expect((await bodyJson(install))['autoSync'], isTrue);

    // 市场行透传
    final List<Map<String, Object?>> apps = await store.listApps();
    expect(apps.single['autoSync'], isTrue);

    // 升级版 zip 继续带 autoSync:true → 保持 true
    final Archive upgradeArchive = Archive();
    void addUp(String name, String content) {
      final List<int> bytes = utf8.encode(content);
      upgradeArchive.addFile(ArchiveFile(name, bytes.length, bytes));
    }

    addUp(
        'bundle.json',
        jsonEncode(<String, Object?>{
          'spec': 1,
          'appId': appId,
          'name': 'svc 测试应用',
          'version': <String, Object?>{'code': 2, 'name': '1.2.0'},
          'frontend': <String, Object?>{'entry': 'pages/index/index'},
          'autoSync': true,
        }));
    addUp('main/app-config.json', '{"app":{"pages":["pages/index/index"]}}');
    addUp('main/logic.js', 'console.log(2)');
    final shelf.Response upgrade = await service.router
        .call(zipRequest('/api/v1/bundle/install', zipBytes(upgradeArchive)));
    expect(upgrade.statusCode, 200);
    expect((await store.listApps()).single['autoSync'], isTrue);

    // 缺省语义:新版 zip 不写 autoSync → 复位 false(缺省 false,逐版本权威)
    final Archive plain = Archive();
    void addPlain(String name, String content) {
      final List<int> bytes = utf8.encode(content);
      plain.addFile(ArchiveFile(name, bytes.length, bytes));
    }

    addPlain(
        'bundle.json',
        jsonEncode(<String, Object?>{
          'spec': 1,
          'appId': appId,
          'name': 'svc 测试应用',
          'version': <String, Object?>{'code': 3, 'name': '1.3.0'},
          'frontend': <String, Object?>{'entry': 'pages/index/index'},
        }));
    addPlain('main/app-config.json', '{"app":{"pages":["pages/index/index"]}}');
    addPlain('main/logic.js', 'console.log(3)');
    final shelf.Response downgradeFlag = await service.router
        .call(zipRequest('/api/v1/bundle/install', zipBytes(plain)));
    expect(downgradeFlag.statusCode, 200);
    expect((await store.listApps()).single['autoSync'], isFalse);
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
    expect((await bodyJson(remove))['purged'], isFalse);
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

  test('remove --purge → data/logs/DB/packages/tokens/notify 全清(闭集)', () async {
    await service.router.call(zipRequest(
        '/api/v1/bundle/install', zipBytes(bundleArchive(code: 1, backend: true))));
    // 种下 purge 闭集内的各类残留:app token、通知模板/订阅/通知对象/应用级开关。
    final String token = await notifyStore.issueToken(appId);
    expect(await notifyStore.tokenBelongsTo(token, appId), isTrue);
    await notifyStore.registerTemplate(appId, '订单状态', const <Map<String, Object?>>[]);
    await notifyStore.applyConsent(appId, templateIdFor(appId, '订单状态'), 'accept');
    final File dataMarker =
        File(p.join(backendsDir.path, appId, 'data', 'state.json'));
    await dataMarker.writeAsString('{"hp":100}');

    final shelf.Response remove = await service.router
        .call(authedRequest('DELETE', '/api/v1/bundle/$appId?purge=1'));
    expect(remove.statusCode, 200);
    final Map<String, Object?> body = await bodyJson(remove);
    expect(body['purged'], isTrue);
    expect(body['schemaDropped'], isTrue);
    expect(body['packageFilesDeleted'], greaterThanOrEqualTo(1));

    // 市场面全清
    expect(await store.latestVersion(appId), isNull);
    expect(
        (await store.listRoutes()).where((x) => x['appId'] == appId), isEmpty);
    // token / 通知闭集全清
    expect(await notifyStore.tokenBelongsTo(token, appId), isFalse);
    expect(await notifyStore.findTemplate(appId, templateIdFor(appId, '订单状态')), isNull);
    // data/logs 整目录消失(purge 与默认保留的分界)
    expect(Directory(p.join(backendsDir.path, appId)).existsSync(), isFalse);
    // packages 分片消失
    expect(
        Directory(cfg.packagesDir)
            .listSync()
            .where((e) => p.basename(e.path).startsWith(appId)),
        isEmpty);
    // schema 已 DROP
    final List<Map<String, Object?>> schemas = await db.q(
        'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        <Object?>['app_$appId']);
    expect(schemas, isEmpty);
  });
}
