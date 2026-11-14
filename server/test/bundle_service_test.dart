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
  Map<String, Object?>? permissions,
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
        if (permissions != null) 'permissions': permissions,
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
    gateway = Gateway(cfg, db, store);
    provisioner = Provisioner(cfg, db, store, gateway, http.Client());
    market = Market(cfg, db, store, backendRunning: provisioner.isRunning);
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

  test('多机可用性:市场行/详情带 backendRunning 运行态,manifest 带 backend 声明', () async {
    Future<Map<String, Object?>> marketJson(String path) async =>
        bodyJson(await market.router
            .call(shelf.Request('GET', Uri.parse('http://svc.test$path'))));
    Future<Map<String, Object?>> marketAppRow(String appId_) async {
      final List<Object?> apps =
          (await marketJson('/api/v1/apps'))['apps'] as List<Object?>;
      return apps.firstWhere(
          (a) => (a as Map<String, Object?>)['appId'] == appId_)
          as Map<String, Object?>;
    }

    // ① 先装纯前端 v1:backend=false,backendRunning 恒 false。
    final shelf.Response v1 =
        await service.router.call(zipRequest('/api/v1/bundle/install',
            zipBytes(bundleArchive(code: 1))));
    expect(v1.statusCode, 200);

    Map<String, Object?> row = await marketAppRow(appId);
    expect(row['backend'], isFalse);
    expect(row['backendRunning'], isFalse);
    Map<String, Object?> detail = await marketJson('/api/v1/apps/$appId');
    expect(detail['backend'], isFalse);
    expect(detail['backendRunning'], isFalse);
    Map<String, Object?> manifest =
        await marketJson('/apps/$appId/manifest.json');
    expect(manifest['backend'], isFalse);

    // ② 升级为带后端 v2:声明翻 true,daemon spawn 健康过门 → 运行态 true。
    final shelf.Response v2 =
        await service.router.call(zipRequest('/api/v1/bundle/install',
            zipBytes(bundleArchive(code: 2, backend: true))));
    expect(v2.statusCode, 200);
    expect(provisioner.isRunning(appId), isTrue);

    row = await marketAppRow(appId);
    expect(row['backend'], isTrue);
    expect(row['backendRunning'], isTrue);
    detail = await marketJson('/api/v1/apps/$appId');
    expect(detail['backend'], isTrue);
    expect(detail['backendRunning'], isTrue);
    manifest = await marketJson('/apps/$appId/manifest.json');
    expect(manifest['backend'], isTrue);

    // ③ 停掉 daemon(模拟换机器/后端没起来):声明还在,运行态翻 false。
    await provisioner.stop(appId);
    row = await marketAppRow(appId);
    expect(row['backend'], isTrue);
    expect(row['backendRunning'], isFalse);
    detail = await marketJson('/api/v1/apps/$appId');
    expect(detail['backendRunning'], isFalse);

    // ④ 整包卸载后市场行消失(手机端本地条目→ 服务器查无此行 → 置灰语义)。
    final shelf.Response remove =
        await service.router.call(authedRequest('DELETE', '/api/v1/bundle/$appId'));
    expect(remove.statusCode, 200);
    final List<Object?> apps =
        (await marketJson('/api/v1/apps'))['apps'] as List<Object?>;
    expect(apps.where((a) => (a as Map<String, Object?>)['appId'] == appId),
        isEmpty);
  });

  test('permissions 声明段(契约 §2/§5):安装落库 → 列表行/manifest 新形态透传,详情端点保持旧形态', () async {
    // 带声明安装:scope.record(授权级)+ glm-quota 同款 network 域名。
    final shelf.Response installed =
        await service.router.call(zipRequest('/api/v1/bundle/install',
            zipBytes(bundleArchive(code: 1, permissions: <String, Object?>{
              'scopes': <Object?>[
                <String, Object?>{
                  'scope': 'scope.record',
                  'desc': '录音测试需要麦克风',
                },
              ],
              'network': <String, Object?>{
                'domains': <String>['https://open.bigmodel.cn'],
              },
            }))));
    expect(installed.statusCode, 200);

    Future<Map<String, Object?>> marketJson(String path) async =>
        bodyJson(await market.router
            .call(shelf.Request('GET', Uri.parse('http://svc.test$path'))));

    // ① 列表行:新形态 {scopes:[{key,title,usage,mode}],network:{domains}};
    //    落库原样 JSON 不出 API(permissionsJson 不存在)。
    final List<Object?> apps =
        (await marketJson('/api/v1/apps'))['apps'] as List<Object?>;
    final Map<String, Object?> row = apps
        .firstWhere((a) => (a as Map<String, Object?>)['appId'] == appId)
        as Map<String, Object?>;
    expect(row.containsKey('permissionsJson'), isFalse);
    final Map<String, Object?> rowPerms = row['permissions'] as Map<String, Object?>;
    final List<Object?> rowScopes = rowPerms['scopes'] as List<Object?>;
    expect(rowScopes, hasLength(1));
    final Map<String, Object?> scope = rowScopes.first as Map<String, Object?>;
    expect(scope['key'], 'scope.record');
    expect(scope['title'], '麦克风/录音');
    expect(scope['usage'], '录音测试需要麦克风');
    expect(scope['mode'], '授权级');
    expect(
        (rowPerms['network'] as Map<String, Object?>)['domains'],
        <String>['https://open.bigmodel.cn']);

    // ② manifest.json:同形态;未声明字段(autoSync 等)不受影响。
    final Map<String, Object?> manifest =
        await marketJson('/apps/$appId/manifest.json');
    final Map<String, Object?> manifestPerms =
        manifest['permissions'] as Map<String, Object?>;
    expect(
        ((manifestPerms['scopes'] as List<Object?>).first
            as Map<String, Object?>)['key'],
        'scope.record');
    expect(
        (manifestPerms['network'] as Map<String, Object?>)['domains'],
        <String>['https://open.bigmodel.cn']);

    // ③ 详情端点:{key,title,usage} 旧形态对齐 dsh-go 现成 section(老 APK
    //    兼容),数据源已是 manifest 落库值。
    final Map<String, Object?> detail =
        await marketJson('/api/v1/apps/$appId');
    final List<Object?> detailPerms = detail['permissions'] as List<Object?>;
    expect(detailPerms, hasLength(1));
    final Map<String, Object?> detailScope =
        detailPerms.first as Map<String, Object?>;
    expect(detailScope['key'], 'scope.record');
    expect(detailScope['title'], '麦克风/录音');
    expect(detailScope['usage'], '录音测试需要麦克风');
    expect(detailScope.containsKey('mode'), isFalse);

    // ④ 回滚捐体行随行:升 v2 后回滚,permissions_json 不丢。
    final shelf.Response upgraded =
        await service.router.call(zipRequest('/api/v1/bundle/install',
            zipBytes(bundleArchive(code: 2, permissions: <String, Object?>{
              'scopes': <Object?>[
                <String, Object?>{
                  'scope': 'scope.record',
                  'desc': '录音测试需要麦克风',
                },
              ],
            }))));
    expect(upgraded.statusCode, 200);
    final shelf.Response rollback = await market.router.call(
        authedRequest('POST', '/api/v1/apps/$appId/rollback'));
    expect(rollback.statusCode, 200);
    final Map<String, Object?> rolledManifest =
        await marketJson('/apps/$appId/manifest.json');
    final Map<String, Object?> rolledPerms =
        rolledManifest['permissions'] as Map<String, Object?>;
    // v1 捐体带 network 域名;旧包新版本号回滚后仍在。
    expect(
        (rolledPerms['network'] as Map<String, Object?>)['domains'],
        <String>['https://open.bigmodel.cn']);

    // ⑤ 未声明(无 permissions 段)升上去(回滚已占掉 code 3,这里用 4):
    //    列表行 permissions=null、manifest 缺字段、详情列表空——纯展示 app
    //    零改动语义。
    final shelf.Response clean =
        await service.router.call(zipRequest('/api/v1/bundle/install',
            zipBytes(bundleArchive(code: 4))));
    expect(clean.statusCode, 200);
    final List<Object?> appsAfter =
        (await marketJson('/api/v1/apps'))['apps'] as List<Object?>;
    final Map<String, Object?> cleanRow = appsAfter
        .firstWhere((a) => (a as Map<String, Object?>)['appId'] == appId)
        as Map<String, Object?>;
    expect(cleanRow['permissions'], isNull);
    final Map<String, Object?> cleanManifest =
        await marketJson('/apps/$appId/manifest.json');
    expect(cleanManifest.containsKey('permissions'), isFalse);
    final Map<String, Object?> cleanDetail =
        await marketJson('/api/v1/apps/$appId');
    expect(cleanDetail['permissions'], isEmpty);
  });
}
