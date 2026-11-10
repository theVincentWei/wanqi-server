/// wanqi — the Wanqi Bundle CLI (Bundle v1 spec §5/§6). Thin HTTP client over
/// the server API; the server owns the gating, unpacking, route registration
/// and auditing:
///
///   wanqi bundle install <zip>     gate → market row → unpack backend/ → routes
///   wanqi bundle upgrade <zip>     same endpoint; server enforces versionCode ↑
///   wanqi bundle rollback --app <id>   current/ ↔ previous/, re-register routes
///   wanqi bundle remove --app <id>     uninstall; data/logs/DB are kept
///   wanqi list                     the market listing
///
/// Common flags: --server http://127.0.0.1:7620  --key <publisherKey>
/// (APPHUB_KEY env is the default key.)
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
  wanqi bundle remove --app <id>     uninstall (data/logs/DB are kept)
  wanqi list                         list installed apps

Common flags: --server http://127.0.0.1:7620  --key <publisherKey>
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
  Future<ApiResult> remove(String server, String key, String appId);
  Future<ApiResult> list(String server, String key);
}

class HttpWanqiApi implements WanqiApi {
  final http.Client _client = http.Client();

  Map<String, String> _headers(String key) => <String, String>{
        if (key.isNotEmpty) 'authorization': 'Bearer $key',
      };

  @override
  Future<ApiResult> install(String server, String key, List<int> zipBytes) async {
    final http.Response response = await _client.post(
      Uri.parse('$server/api/v1/bundle/install'),
      headers: <String, String>{
        ..._headers(key),
        'content-type': 'application/zip',
      },
      body: zipBytes,
    );
    return ApiResult(response.statusCode, response.body);
  }

  @override
  Future<ApiResult> rollback(String server, String key, String appId) async {
    final http.Response response = await _client
        .post(Uri.parse('$server/api/v1/bundle/$appId/rollback'), headers: _headers(key));
    return ApiResult(response.statusCode, response.body);
  }

  @override
  Future<ApiResult> remove(String server, String key, String appId) async {
    final http.Response response =
        await _client.delete(Uri.parse('$server/api/v1/bundle/$appId'), headers: _headers(key));
    return ApiResult(response.statusCode, response.body);
  }

  @override
  Future<ApiResult> list(String server, String key) async {
    final http.Response response =
        await _client.get(Uri.parse('$server/api/v1/apps'), headers: _headers(key));
    return ApiResult(response.statusCode, response.body);
  }
}

class WanqiCli {
  WanqiCli({WanqiApi? api, String? defaultServer, String? envKey})
      : api = api ?? HttpWanqiApi(),
        defaultServer = defaultServer ?? 'http://127.0.0.1:7620',
        envKey = envKey ?? Platform.environment['APPHUB_KEY'] ?? '';

  final WanqiApi api;
  final String defaultServer;
  final String envKey;

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
        return api.list(parsed['server'] as String, parsed['key'] as String);
      case '':
        throw WanqiUsageException('a command is required');
      default:
        throw WanqiUsageException('unknown command "$command"');
    }
  }

  ArgParser _commonParser() => ArgParser()
    ..addOption('server', defaultsTo: defaultServer)
    ..addOption('key', defaultsTo: envKey);

  Future<ApiResult> _bundle(List<String> rest) async {
    if (rest.isEmpty) {
      throw WanqiUsageException(
          'bundle needs a subcommand: install | upgrade | rollback | remove');
    }
    final String sub = rest.first;
    final ArgParser parser = _commonParser()..addOption('app');
    final ArgResults parsed;
    try {
      parsed = parser.parse(rest.skip(1).toList());
    } on ArgParserException catch (error) {
      throw WanqiUsageException(error.message);
    }
    final String server = parsed['server'] as String;
    final String key = parsed['key'] as String;

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
      case 'remove':
        final String? appId = parsed['app'] as String?;
        if (appId == null || appId.isEmpty) {
          throw WanqiUsageException('$sub needs --app <id>');
        }
        return sub == 'rollback'
            ? api.rollback(server, key, appId)
            : api.remove(server, key, appId);
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
