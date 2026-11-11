/// wanqi — the Wanqi Bundle CLI (Bundle v1 spec §5/§6). Thin HTTP client over
/// the server API; the server owns the gating, unpacking, route registration
/// and auditing:
///
///   wanqi bundle install <zip>     gate → market row → unpack backend/ → routes
///   wanqi bundle upgrade <zip>     same endpoint; server enforces versionCode ↑
///   wanqi bundle rollback --app <id>   roll the whole bundle back to the previous
///                                      version (market row + backend code)
///   wanqi bundle remove --app <id> [--purge]
///                                  uninstall; --purge wipes host data too
///                                  (手机端整包卸载的清除勾选,见 spec §6)
///   wanqi list                     the market listing
///
/// Common flags: --server http://127.0.0.1:7620  --key <publisherKey>
/// (--key 缺省自动解析:APPHUB_KEY env → 主机 config 文件,命令串无需出现密钥。)
library;

import 'dart:convert';
import 'dart:io';

import 'package:args/args.dart';
import 'package:http/http.dart' as http;

const String _usage = '''
Usage: wanqi — Wanqi Bundle CLI

  wanqi bundle install <zip>         install a bundle (first install or upgrade)
  wanqi bundle upgrade <zip>         upgrade (version.code must strictly increase)
  wanqi bundle rollback --app <id>   roll the whole bundle back to the previous
                                     version (market row + backend code)
  wanqi bundle remove --app <id> [--purge]
                                     uninstall; --purge also wipes host data/
                                     logs/DB/packages (手机端整包卸载的清除勾选)
  wanqi list                         list installed apps

Common flags: --server http://127.0.0.1:7620  --key <publisherKey>
(--key 未给时自动解析:APPHUB_KEY env → 主机 config 文件,无需写在命令串里。)
''';

/// Thrown for anything usage-level: prints a message + usage, exit code 64.
class WanqiUsageException implements Exception {
  WanqiUsageException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// One server answer, decoded for the CLI.
class ApiResult {
  ApiResult(this.statusCode, this.body);

  final int statusCode;
  final String body;

  bool get ok => statusCode >= 200 && statusCode < 300;
}

/// The HTTP surface the CLI uses. Abstracted so tests can record calls
/// without any network.
abstract class WanqiApi {
  Future<ApiResult> install(String server, String key, List<int> zipBytes);
  Future<ApiResult> rollback(String server, String key, String appId);
  Future<ApiResult> remove(String server, String key, String appId,
      {bool purge = false});
  Future<ApiResult> list(String server, String key);
}

class HttpWanqiApi implements WanqiApi {
  /// One-shot clients, closed after every call. A long-lived client holds a
  /// keep-alive socket whose HttpClient.idleTimeout (15s) would otherwise
  /// keep the event loop alive after main() returns — every CLI invocation
  /// appeared to take ~15s while the actual work took milliseconds.
  Future<ApiResult> _run(Future<http.Response> Function(http.Client) action) async {
    final http.Client client = http.Client();
    try {
      final http.Response response = await action(client);
      return ApiResult(response.statusCode, response.body);
    } finally {
      client.close();
    }
  }

  @override
  Future<ApiResult> install(String server, String key, List<int> zipBytes) {
    return _run((client) => client.post(
          Uri.parse('$server/api/v1/bundle/install'),
          headers: <String, String>{
            ..._headers(key),
            'content-type': 'application/zip',
          },
          body: zipBytes,
        ));
  }

  @override
  Future<ApiResult> rollback(String server, String key, String appId) {
    return _run((client) => client.post(
        Uri.parse('$server/api/v1/bundle/$appId/rollback'), headers: _headers(key)));
  }

  @override
  Future<ApiResult> remove(String server, String key, String appId,
      {bool purge = false}) {
    return _run((client) => client.delete(
        Uri.parse('$server/api/v1/bundle/$appId${purge ? '?purge=1' : ''}'),
        headers: _headers(key)));
  }

  @override
  Future<ApiResult> list(String server, String key) {
    return _run((client) =>
        client.get(Uri.parse('$server/api/v1/apps'), headers: _headers(key)));
  }

  Map<String, String> _headers(String key) => <String, String>{
        if (key.isNotEmpty) 'authorization': 'Bearer $key',
      };
}

class WanqiCli {
  WanqiCli({WanqiApi? api, String? defaultServer, String? envKey, String? home, String? cwd})
      : api = api ?? HttpWanqiApi(),
        defaultServer = defaultServer ?? 'http://127.0.0.1:7620',
        envKey = envKey ?? Platform.environment['APPHUB_KEY'] ?? '',
        home = home ?? Platform.environment['HOME'],
        cwd = cwd ?? Directory.current.path;

  final WanqiApi api;
  final String defaultServer;
  final String envKey;

  /// 主机 config 解析用(测试可注入,生产走真实环境)。
  final String? home;
  final String? cwd;

  /// --key 未显式给出时的解析顺序:APPHUB_KEY env → 主机 config 文件
  /// (cwd/config.local.json → ~/Code/wanqi/server/config.local.json →
  /// ~/dsh/apphub/config.json)。手机端卸载经引擎命令通道在主机执行本 CLI,
  /// 密钥因此从主机 config 默认读取,命令串不出现密钥(task-11)。
  String resolveKey({String? explicit}) {
    if (explicit != null && explicit.isNotEmpty) return explicit;
    if (envKey.isNotEmpty) return envKey;
    final String homeDir = home ?? '.';
    for (final String path in <String>[
      '$cwd/config.local.json',
      '$homeDir/Code/wanqi/server/config.local.json',
      '$homeDir/dsh/apphub/config.json',
    ]) {
      final String? key = publisherKeyFromFile(path);
      if (key != null) return key;
    }
    return '';
  }

  /// 从一个 config JSON 读 publisherKey;不存在/坏 JSON → null。
  static String? publisherKeyFromFile(String path) {
    try {
      final Object? decoded = jsonDecode(File(path).readAsStringSync());
      if (decoded is Map) {
        final Object? key = decoded['publisherKey'];
        if (key is String && key.isNotEmpty) return key;
      }
    } catch (_) {
      // 缺文件/不可读 → 尝试下一个候选。
    }
    return null;
  }

  /// Runs one invocation; returns the process exit code. [out]/[err] default
  /// to the process streams; tests pass capturing sinks.
  Future<int> run(List<String> args, {StringSink? out, StringSink? err}) async {
    final StringSink stdoutSink = out ?? stdout;
    final StringSink stderrSink = err ?? stderr;
    try {
      final ApiResult result = await _dispatch(args);
      stdoutSink.writeln(_pretty(result));
      if (!result.ok) return 1;
      return 0;
    } on WanqiUsageException catch (error) {
      stderrSink.writeln('wanqi: ${error.message}');
      stderrSink.write(_usage);
      return 64;
    } catch (error) {
      stderrSink.writeln('wanqi: error: $error');
      return 1;
    }
  }

  Future<ApiResult> _dispatch(List<String> args) async {
    final String command = args.isEmpty ? '' : args.first;
    final List<String> rest = args.skip(1).toList();

    switch (command) {
      case 'bundle':
        return _bundle(rest);
      case 'list':
        final ArgResults parsed = _commonParser().parse(rest);
        return api.list(
            parsed['server'] as String, resolveKey(explicit: parsed['key'] as String?));
      case '':
        throw WanqiUsageException('a command is required');
      default:
        throw WanqiUsageException('unknown command "$command"');
    }
  }

  ArgParser _commonParser() => ArgParser()
    ..addOption('server', defaultsTo: defaultServer)
    ..addOption('key', defaultsTo: '');

  Future<ApiResult> _bundle(List<String> rest) async {
    if (rest.isEmpty) {
      throw WanqiUsageException(
          'bundle needs a subcommand: install | upgrade | rollback | remove');
    }
    final String sub = rest.first;
    final ArgParser parser = _commonParser()
      ..addOption('app')
      ..addFlag('purge', defaultsTo: false, help: 'remove 同时清除主机 data/logs/DB/packages(整包语义的清除勾选)');
    final ArgResults parsed;
    try {
      parsed = parser.parse(rest.skip(1).toList());
    } on ArgParserException catch (error) {
      throw WanqiUsageException(error.message);
    }
    final String server = parsed['server'] as String;
    final String key = resolveKey(explicit: parsed['key'] as String?);

    switch (sub) {
      case 'install':
      case 'upgrade':
        if (parsed.rest.isEmpty) {
          throw WanqiUsageException('$sub needs a bundle zip path');
        }
        if (parsed.rest.length > 1) {
          throw WanqiUsageException('$sub takes exactly one zip path');
        }
        final String zipPath = parsed.rest.first;
        final File zip = File(zipPath);
        if (!await zip.exists()) {
          throw WanqiUsageException('no such zip: $zipPath');
        }
        return api.install(server, key, await zip.readAsBytes());
      case 'rollback':
        final String? appId = parsed['app'] as String?;
        if (appId == null || appId.isEmpty) {
          throw WanqiUsageException('$sub needs --app <id>');
        }
        return api.rollback(server, key, appId);
      case 'remove':
        final String? appId = parsed['app'] as String?;
        if (appId == null || appId.isEmpty) {
          throw WanqiUsageException('$sub needs --app <id>');
        }
        return api.remove(server, key, appId, purge: parsed['purge'] as bool? ?? false);
      default:
        throw WanqiUsageException('unknown bundle subcommand "$sub"');
    }
  }

  String _pretty(ApiResult result) {
    String body = result.body;
    try {
      body = const JsonEncoder.withIndent('  ').convert(jsonDecode(result.body));
    } catch (_) {
      // Server sent non-JSON (e.g. plain text) — print it raw.
    }
    return '${result.statusCode} $body';
  }
}
