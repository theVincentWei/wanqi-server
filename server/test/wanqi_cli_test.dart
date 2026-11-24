// wanqi CLI tests: argument parsing, dispatch shapes and exit codes against
// a recording fake API — no network, no server.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:apphub/wanqi_cli.dart';
import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

class _Sink implements StringSink {
  final StringBuffer _buffer = StringBuffer();

  String get text => _buffer.toString();

  @override
  void write(Object? object) => _buffer.write(object);

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      _buffer.writeAll(objects, separator);

  @override
  void writeCharCode(int charCode) => _buffer.writeCharCode(charCode);

  @override
  void writeln([Object? object = '']) => _buffer.writeln(object);
}

class _Call {
  _Call(this.kind, this.server, this.key, [this.appId, this.zipBytes, this.purge = false]);

  final String kind;
  final String server;
  final String key;
  final String? appId;
  final List<int>? zipBytes;
  final bool purge;
}

class _FakeApi implements WanqiApi {
  final List<_Call> calls = <_Call>[];
  int statusCode = 200;
  String body = '{"ok":true}';

  ApiResult _result(_Call call) {
    calls.add(call);
    return ApiResult(statusCode, body);
  }

  @override
  Future<ApiResult> install(String server, String key, List<int> zipBytes) async =>
      _result(_Call('install', server, key, null, zipBytes));

  @override
  Future<ApiResult> rollback(String server, String key, String appId) async =>
      _result(_Call('rollback', server, key, appId));

  @override
  Future<ApiResult> remove(String server, String key, String appId,
      {bool purge = false}) async =>
      _result(_Call('remove', server, key, appId, null, purge));

  @override
  Future<ApiResult> list(String server, String key) async =>
      _result(_Call('list', server, key));

  @override
  Future<ApiResult> pets(String server, String key) async =>
      _result(_Call('pets', server, key));

  @override
  Future<ApiResult> publishPet(String server, String key, String petId,
      List<int> zipBytes,
      {String? name}) async =>
      _result(_Call('publishPet', server, key, petId, zipBytes));
}

Future<File> tempZip() async {
  final Directory dir = await Directory.systemTemp.createTemp('wanqi-cli-test-');
  final File file = File(p.join(dir.path, 'test.bundle.zip'));
  await file.writeAsBytes(utf8.encode('fake zip bytes'));
  return file;
}

void main() {
  late _FakeApi api;
  late WanqiCli cli;

  setUp(() {
    api = _FakeApi();
    cli = WanqiCli(api: api, defaultServer: 'http://127.0.0.1:7620', envKey: 'test-key');
  });

  group('usage errors (exit 64, usage on stderr)', () {
    test('no args', () async {
      final _Sink out = _Sink();
      final _Sink err = _Sink();
      final int code = await cli.run(<String>[], out: out, err: err);
      expect(code, 64);
      expect(err.text, contains('Usage:'));
      expect(err.text, contains('bundle install'));
      expect(out.text, isEmpty);
    });

    test('unknown command', () async {
      final int code = await cli.run(<String>['frobnicate'], out: _Sink(), err: _Sink());
      expect(code, 64);
    });

    test('bundle without subcommand', () async {
      final int code = await cli.run(<String>['bundle'], out: _Sink(), err: _Sink());
      expect(code, 64);
    });

    test('unknown bundle subcommand', () async {
      final int code =
          await cli.run(<String>['bundle', 'explode'], out: _Sink(), err: _Sink());
      expect(code, 64);
    });

    test('install without zip path', () async {
      final int code =
          await cli.run(<String>['bundle', 'install'], out: _Sink(), err: _Sink());
      expect(code, 64);
      expect(api.calls, isEmpty);
    });

    test('install with two zip paths', () async {
      final int code = await cli.run(<String>['bundle', 'install', 'a.zip', 'b.zip'],
          out: _Sink(), err: _Sink());
      expect(code, 64);
    });

    test('install with missing file', () async {
      final int code = await cli.run(
          <String>['bundle', 'install', '/no/such/bundle.zip'],
          out: _Sink(), err: _Sink());
      expect(code, 64);
    });

    test('rollback without --app', () async {
      final int code =
          await cli.run(<String>['bundle', 'rollback'], out: _Sink(), err: _Sink());
      expect(code, 64);
      expect(api.calls, isEmpty);
    });

    test('remove without --app', () async {
      final int code =
          await cli.run(<String>['bundle', 'remove'], out: _Sink(), err: _Sink());
      expect(code, 64);
    });
  });

  group('dispatch shapes', () {
    test('install posts zip bytes to the bundle endpoint', () async {
      final File zip = await tempZip();
      final _Sink out = _Sink();
      final int code =
          await cli.run(<String>['bundle', 'install', zip.path], out: out, err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'install');
      expect(api.calls.single.server, 'http://127.0.0.1:7620');
      expect(api.calls.single.key, 'test-key');
      expect(utf8.decode(Uint8List.fromList(api.calls.single.zipBytes!)),
          'fake zip bytes');
      expect(out.text, startsWith('200'));
    });

    test('pet publish reads the petId from the zip pack.json', () async {
      final Directory dir = await Directory.systemTemp.createTemp('wanqi-pet-test-');
      final packJson = utf8.encode(jsonEncode(<String, Object?>{
        'id': 'home-cat',
        'name': '家里的猫',
        'version': '1.0.0',
      }));
      final Archive archive = Archive()
        ..addFile(ArchiveFile('pack.json', packJson.length, packJson))
        ..addFile(ArchiveFile('idle.png', 3, <int>[1, 2, 3]));
      final File zip = File(p.join(dir.path, 'home-cat.zip'));
      await zip.writeAsBytes(ZipEncoder().encode(archive)!, flush: true);
      final _Sink out = _Sink();
      final int code =
          await cli.run(<String>['pet', 'publish', zip.path, '--name', '小猫'],
              out: out, err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'publishPet');
      expect(api.calls.single.appId, 'home-cat');
      expect(api.calls.single.zipBytes, isNotEmpty);
      expect(out.text, startsWith('200'));
      await dir.delete(recursive: true);
    });

    test('pet publish without a pack.json is a usage error', () async {
      final File zip = await tempZip(); // fake bytes, not a zip
      final int code = await cli.run(<String>['pet', 'publish', zip.path],
          out: _Sink(), err: _Sink());
      expect(code, 64);
      expect(api.calls, isEmpty);
    });

    test('pets lists the pet catalog', () async {
      final int code = await cli.run(<String>['pets'], out: _Sink(), err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'pets');
      expect(api.calls.single.server, 'http://127.0.0.1:7620');
    });

    test('--server and --key override defaults', () async {
      final File zip = await tempZip();
      await cli.run(<String>[
        'bundle', 'upgrade', zip.path,
        '--server', 'http://10.0.0.9:9999',
        '--key', 'other-key',
      ], out: _Sink(), err: _Sink());
      expect(api.calls.single.server, 'http://10.0.0.9:9999');
      expect(api.calls.single.key, 'other-key');
    });

    test('rollback passes the appId', () async {
      final int code = await cli.run(<String>['bundle', 'rollback', '--app', 'wxabc'],
          out: _Sink(), err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'rollback');
      expect(api.calls.single.appId, 'wxabc');
    });

    test('remove passes the appId', () async {
      final int code = await cli.run(<String>['bundle', 'remove', '--app', 'wxabc'],
          out: _Sink(), err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'remove');
      expect(api.calls.single.appId, 'wxabc');
      expect(api.calls.single.purge, isFalse);
    });

    test('remove --purge 传播到 api 调用(整包语义清除勾选)', () async {
      final int code = await cli.run(
          <String>['bundle', 'remove', '--app', 'wxabc', '--purge'],
          out: _Sink(), err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'remove');
      expect(api.calls.single.purge, isTrue);
    });

    test('rollback 与 remove 不再混用同一分支(remove 缺 --app 报 usage)', () async {
      final int code = await cli.run(<String>['bundle', 'remove'], out: _Sink(), err: _Sink());
      expect(code, 64);
    });

    test('list hits /api/v1/apps via the api client', () async {
      final int code = await cli.run(<String>['list'], out: _Sink(), err: _Sink());
      expect(code, 0);
      expect(api.calls.single.kind, 'list');
    });
  });

  group('resolveKey(--key 缺省从主机 config 读取,task-11)', () {
    test('显式 --key 最优先', () {
      expect(cli.resolveKey(explicit: 'explicit-key'), 'explicit-key');
    });

    test('env 次之', () {
      expect(cli.resolveKey(), 'test-key');
    });

    test('config 文件兜底:cwd/config.local.json', () {
      final Directory dir = Directory.systemTemp.createTempSync('wanqi-key-');
      File('${dir.path}/config.local.json')
          .writeAsStringSync('{"publisherKey":"from-config"}');
      try {
        final WanqiCli local = WanqiCli(
            api: api, defaultServer: 'http://x', envKey: '', home: '/nohome', cwd: dir.path);
        expect(local.resolveKey(), 'from-config');
      } finally {
        dir.deleteSync(recursive: true);
      }
    });

    test('config 兜底顺序:home 下 wanqi server config 次于 cwd,先于 dsh/apphub', () {
      final Directory home = Directory.systemTemp.createTempSync('wanqi-home-');
      Directory('${home.path}/Code/wanqi/server').createSync(recursive: true);
      File('${home.path}/Code/wanqi/server/config.local.json')
          .writeAsStringSync('{"publisherKey":"from-repo"}');
      try {
        final WanqiCli local = WanqiCli(
            api: api, defaultServer: 'http://x', envKey: '', home: home.path, cwd: '/nope');
        expect(local.resolveKey(), 'from-repo');
      } finally {
        home.deleteSync(recursive: true);
      }
    });

    test('全链无 key → 空串(服务端 401,由调用方看错误)', () {
      final WanqiCli local = WanqiCli(
          api: api, defaultServer: 'http://x', envKey: '', home: '/nohome', cwd: '/nope');
      expect(local.resolveKey(), '');
    });

    test('坏 JSON config 被跳过不抛', () {
      final Directory dir = Directory.systemTemp.createTempSync('wanqi-key-bad-');
      File('${dir.path}/config.local.json').writeAsStringSync('{not json');
      try {
        final WanqiCli local = WanqiCli(
            api: api, defaultServer: 'http://x', envKey: '', home: '/nohome', cwd: dir.path);
        expect(local.resolveKey(), '');
      } finally {
        dir.deleteSync(recursive: true);
      }
    });
  });

  group('result handling', () {
    test('HTTP 4xx/5xx → exit 1 with the body printed', () async {
      api.statusCode = 409;
      api.body = '{"error":"version.code must be > 10"}';
      final _Sink out = _Sink();
      final int code = await cli.run(
          <String>['bundle', 'remove', '--app', 'x'], out: out, err: _Sink());
      expect(code, 1);
      expect(out.text, contains('409'));
      expect(out.text, contains('version.code must be > 10'));
    });

    test('non-JSON body still printed raw', () async {
      api.body = 'plain oops';
      api.statusCode = 500;
      final _Sink out = _Sink();
      final int code =
          await cli.run(<String>['bundle', 'remove', '--app', 'x'], out: out, err: _Sink());
      expect(code, 1);
      expect(out.text, contains('plain oops'));
    });
  });
}
