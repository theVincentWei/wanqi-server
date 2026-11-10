/// Backend provisioning (Bundle v1 step 2, spec §5④/⑥): spawn the unpacked
/// backend as a server child process on a dynamically assigned loopback
/// port, probe its health path until 200 ("installed"), own the route table
/// targets, and supervise it — crash → exponential backoff respawn; server
/// boot → re-spawn every installed backend found on disk (§6 常驻).
///
/// Environment injected into every backend (spec §4 固定约定):
///   APPHUB_PORT / APPHUB_APP_ID / APPHUB_DB_URL
/// Backends bind 127.0.0.1 only; the gateway is their only public face.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;

import 'bundle.dart';
import 'bundle_fs.dart';
import 'config.dart';
import 'db.dart';
import 'gateway.dart';
import 'store.dart';

/// Health probe window after spawn — "200 才算装好" (§5④).
const Duration healthTimeout = Duration(seconds: 15);

/// Poll cadence while probing the health path.
const Duration healthPollInterval = Duration(milliseconds: 300);

/// Crash respawn backoff: 1, 2, 4, 8, 16, 30, 30 … (capped).
const List<int> backoffSeconds = <int>[1, 2, 4, 8, 16, 30];

/// A backend that stayed alive this long counts as stable — its backoff
/// stage resets on the next crash.
const Duration stableAfter = Duration(seconds: 60);

/// Grace period after SIGTERM before SIGKILL.
const Duration killGrace = Duration(seconds: 3);

class StartResult {
  const StartResult.ok(this.port, this.pid)
      : ok = true,
        error = null;
  const StartResult.fail(this.error)
      : ok = false,
        port = null,
        pid = null;

  final bool ok;
  final int? port;
  final int? pid;
  final String? error;
}

/// Per-app daemon log sink that survives both stdio streams closing.
class _LogSink {
  _LogSink(this._file);

  final File _file;
  IOSink? _sink;
  int _writers = 0;

  void attach(Process process, String appId) {
    try {
      _sink ??= _file.openWrite(mode: FileMode.append);
    } catch (_) {
      return; // Logging must never take the supervisor down.
    }
    _writers += 1;
    process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen(
        (String line) {
      _line(appId, line);
    }, onDone: _detach);
    _writers += 1;
    process.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen(
        (String line) {
      _line(appId, '[stderr] $line');
    }, onDone: _detach);
  }

  void _detach() {
    _writers -= 1;
    if (_writers <= 0) {
      final IOSink? sink = _sink;
      _sink = null;
      sink?.flush().then((_) => sink.close()).catchError((Object _) {});
    }
  }

  void _line(String appId, String text) {
    final String stamped =
        '${DateTime.now().toIso8601String()} [$appId] $text';
    stdout.writeln(stamped);
    try {
      _sink?.writeln(stamped);
    } catch (_) {}
  }
}

/// One supervised backend process. All mutable state lives here so a crash
/// timer from a superseded instance can never respawn over a newer one —
/// [stopping] flips on stop(), which every replacement path calls first.
class _Instance {
  _Instance(this.appId, this.manifest, this.paths);

  final String appId;
  BundleManifest manifest;
  BackendPaths paths;

  Process? process;
  int? port;
  int? pid;
  bool running = false;
  bool stopping = false;
  int restarts = 0;
  int? lastExitCode;
  DateTime? startedAt;
  int backoffStage = 0;
  Timer? backoffTimer;
}

class Provisioner {
  Provisioner(this.cfg, this.db, this.store, this.gateway, this._http);

  final AppConfig cfg;
  final Db db;
  final Store store;
  final Gateway gateway;
  final http.Client _http;

  final Map<String, _Instance> _instances = <String, _Instance>{};

  BackendPaths _paths(String appId) =>
      BackendPaths(p.join(cfg.backendsDir, appId));

  File _logFile(BackendPaths paths) {
    final String day =
        DateTime.now().toIso8601String().substring(0, 10).replaceAll('-', '');
    return File(p.join(paths.logs, 'daemon-$day.log'));
  }

  void _log(BackendPaths paths, String appId, String line) {
    final String stamped = '${DateTime.now().toIso8601String()} [$appId] $line';
    stdout.writeln(stamped);
    try {
      _logFile(paths).writeAsStringSync('$stamped\n', mode: FileMode.append);
    } catch (_) {
      // Logging must never take the supervisor down.
    }
  }

  /// Whether [appId] currently has a live supervised process.
  bool isRunning(String appId) => _instances[appId]?.running ?? false;

  /// Status snapshot for the API (acceptance evidence / ops).
  Map<String, Object?>? status(String appId) {
    final _Instance? instance = _instances[appId];
    if (instance == null) return null;
    return <String, Object?>{
      'appId': appId,
      'running': instance.running,
      'port': instance.port,
      'pid': instance.pid,
      'restarts': instance.restarts,
      'lastExitCode': instance.lastExitCode,
      'startedAt': instance.startedAt?.toIso8601String(),
      'versionCode': instance.manifest.versionCode,
      'health': instance.manifest.backend?.health ?? '',
    };
  }

  List<Map<String, Object?>> statusAll() =>
      <Map<String, Object?>>[for (final String id in _instances.keys) status(id)!];

  /// Full spawn path used by install/upgrade/rollback/restore: stale-pid
  /// cleanup → allocate loopback port → spawn → health probe → route
  /// targets. Never throws; failures come back as [StartResult.fail].
  Future<StartResult> start(String appId, BundleManifest manifest) async {
    final BackendPaths paths = _paths(appId);
    if (manifest.backend == null) {
      return StartResult.fail('manifest has no backend section');
    }
    await _killStaleFromPidFile(paths, appId, manifest);

    final _Instance instance = _Instance(appId, manifest, paths);
    instance.stopping = false;
    _instances[appId] = instance; // supersedes any older instance object
    final StartResult result = await _spawn(instance);
    if (result.ok) {
      _log(paths, appId,
          'started pid=${result.pid} port=${result.port} (v${manifest.versionCode})');
    } else {
      _log(paths, appId, 'start failed: ${result.error}');
    }
    return result;
  }

  /// The raw spawn+probe+route half, shared with crash respawns (which must
  /// not re-run stale-pid cleanup or replace the instance object).
  Future<StartResult> _spawn(_Instance instance) async {
    final BundleBackend? backend = instance.manifest.backend;
    if (backend == null) return StartResult.fail('no backend section');

    final int port = await _freePort();
    final String entryFile = backendStartEntry(backend.start) ?? '';
    try {
      final Process process = await Process.start(
        '/bin/bash',
        <String>['-c', backend.start],
        workingDirectory: instance.paths.current,
        environment: <String, String>{
          'APPHUB_PORT': '$port',
          'APPHUB_APP_ID': instance.appId,
          'APPHUB_DB_URL': _dbUrl(instance.appId),
          if (entryFile.isNotEmpty) 'APPHUB_ENTRY': entryFile,
        },
      );
      instance.process = process;
      instance.port = port;
      instance.pid = process.pid;
      instance.running = true;
      instance.startedAt = DateTime.now();
      instance.lastExitCode = null;
      _LogSink(_logFile(instance.paths)).attach(process, instance.appId);
      unawaited(_writePidFile(instance));

      // ⑥ 常驻: crash → backoff respawn. A manual stop() flips [stopping]
      // before killing, so this handler is a no-op for deliberate ends.
      unawaited(process.exitCode.then((Object? code) async {
        instance.running = false;
        instance.lastExitCode = code is int ? code : null;
        _log(instance.paths, instance.appId,
            'exited code=${instance.lastExitCode}');
        await _deletePidFile(instance.paths);
        if (instance.stopping) return;
        // Stable runs reset the backoff ladder; rapid crash loops climb it.
        final DateTime now = DateTime.now();
        final bool wasStable = instance.startedAt != null &&
            now.difference(instance.startedAt!) > stableAfter;
        instance.backoffStage = wasStable ? 0 : instance.backoffStage + 1;
        final int delay = backoffSeconds[
            instance.backoffStage.clamp(0, backoffSeconds.length - 1)];
        instance.restarts += 1;
        _log(instance.paths, instance.appId,
            'crash respawn in ${delay}s (stage ${instance.backoffStage}, restarts ${instance.restarts})');
        instance.backoffTimer = Timer(Duration(seconds: delay), () async {
          if (instance.stopping) return;
          final StartResult again = await _spawn(instance);
          if (!again.ok) {
            _log(instance.paths, instance.appId,
                'respawn failed: ${again.error}');
          }
        });
      }));

      // ④ health gate: 200 才算装好.
      final bool healthy = await _probe(instance, backend.health, port);
      if (!healthy) {
        await _terminate(instance);
        return StartResult.fail(
            'health probe "${backend.health}" on :$port did not return 200 '
            'within ${healthTimeout.inSeconds}s');
      }

      // ⑤ route targets now point at the live port.
      await _registerRoutes(instance, port);
      return StartResult.ok(port, process.pid);
    } catch (error) {
      return StartResult.fail('spawn "${backend.start}" failed: $error');
    }
  }

  /// SIGTERM → grace → SIGKILL; suppresses the crash-respawn handler and
  /// forgets the instance. Safe to call for unknown/never-started apps.
  Future<void> stop(String appId) async {
    final _Instance? instance = _instances[appId];
    if (instance == null) return;
    instance.stopping = true;
    instance.backoffTimer?.cancel();
    await _terminate(instance);
    await _deletePidFile(instance.paths);
    _log(instance.paths, appId, 'stopped');
    _instances.remove(appId);
  }

  Future<void> _terminate(_Instance instance) async {
    final Process? process = instance.process;
    instance.running = false;
    if (process == null) return;
    instance.process = null;
    process.kill(ProcessSignal.sigterm);
    try {
      await process.exitCode.timeout(killGrace);
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      try {
        await process.exitCode.timeout(killGrace);
      } on TimeoutException {
        // Rare: SIGKILL ignored — give up waiting, the process is doomed.
      }
    }
  }

  Future<void> _registerRoutes(_Instance instance, int port) async {
    final List<String> prefixes =
        instance.manifest.backend?.gateway ?? const <String>[];
    await store.deleteRoutesForApp(instance.appId);
    for (final String prefix in prefixes) {
      await store.upsertRoute(
          instance.appId, prefix, 'http://127.0.0.1:$port', 5000, 120);
    }
    await gateway.reload();
    await db.audit('bundle', 'bundle.spawn',
        '${instance.appId} port=$port prefixes=$prefixes');
  }

  /// GET <health> on the freshly spawned port until 200 or the deadline.
  /// Empty health path = the bundle declares no probe → accept immediately.
  Future<bool> _probe(_Instance instance, String health, int port) async {
    if (health.isEmpty) return true;
    final Uri uri = Uri.parse('http://127.0.0.1:$port$health');
    final DateTime deadline = DateTime.now().add(healthTimeout);
    while (DateTime.now().isBefore(deadline)) {
      if (instance.stopping || !instance.running) return false;
      try {
        final http.Response response =
            await _http.get(uri).timeout(healthPollInterval * 4);
        if (response.statusCode == 200) {
          _log(instance.paths, instance.appId, 'health 200 on ${uri.path}');
          return true;
        }
      } catch (_) {
        // Not up yet — keep polling until the deadline.
      }
      await Future<void>.delayed(healthPollInterval);
    }
    return false;
  }

  /// The per-app MariaDB identity minted at publish time (§4 环境变量三件套).
  String _dbUrl(String appId) {
    final String user = 'app_$appId';
    final String schema = 'app_$appId';
    final String password = Uri.encodeComponent(cfg.appDbPassword);
    return 'mysql://$user:$password@${cfg.db.host}:${cfg.db.port}/$schema';
  }

  Future<int> _freePort() async {
    final ServerSocket socket =
        await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final int port = socket.port;
    await socket.close();
    return port;
  }

  File _pidFile(BackendPaths paths) => File(p.join(paths.root, 'daemon.pid'));

  Future<void> _writePidFile(_Instance instance) async {
    try {
      await _pidFile(instance.paths).writeAsString('${instance.pid}');
    } catch (_) {}
  }

  Future<void> _deletePidFile(BackendPaths paths) async {
    try {
      final File file = _pidFile(paths);
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  /// Server-restart hygiene: a backend spawned by a previous server life
  /// outlives it (orphaned to launchd). If the pidfile names a live process
  /// whose command line still matches this bundle's entry file, kill it —
  /// otherwise leave it alone (pid reuse guard).
  Future<void> _killStaleFromPidFile(
      BackendPaths paths, String appId, BundleManifest manifest) async {
    try {
      final File file = _pidFile(paths);
      if (!await file.exists()) return;
      final int? pid = int.tryParse((await file.readAsString()).trim());
      if (pid == null || pid <= 1) return;
      final ProcessResult ps =
          await Process.run('ps', <String>['-o', 'command=', '-p', '$pid']);
      final String command = ps.stdout.toString().trim();
      final String? entryFile =
          backendStartEntry(manifest.backend?.start ?? '');
      final bool ours = entryFile != null &&
          entryFile.isNotEmpty &&
          command.contains(entryFile);
      if (!ours) {
        _log(paths, appId,
            'stale pid $pid not ours (${command.isEmpty ? 'gone' : command}) — leaving it');
        return;
      }
      _log(paths, appId, 'killing orphan from previous server life: pid $pid');
      await Process.run('kill', <String>['-TERM', '$pid']);
      await Process.run('sh', <String>[
        '-c',
        'for i in 1 2 3 4 5 6; do ps -p $pid >/dev/null 2>&1 || exit 0; sleep 0.5; done; kill -KILL $pid 2>/dev/null; exit 0',
      ]);
      await _deletePidFile(paths);
    } catch (_) {
      // Best-effort: never block startup on hygiene.
    }
  }

  /// Boot-time 常驻 (§6): every installed app with a backend section found
  /// under backendsDir gets re-spawned. Pure directory scan — v1 keeps no
  /// wish list. Returns how many backends came up healthy.
  Future<int> restoreAll() async {
    final Directory root = Directory(cfg.backendsDir);
    if (!await root.exists()) return 0;
    int started = 0;
    await for (final FileSystemEntity entry in root.list()) {
      if (entry is! Directory) continue;
      final String appId = p.basename(entry.path);
      if (!isValidAppId(appId)) continue;
      final BackendPaths paths = BackendPaths(entry.path);
      final File manifestFile = File(p.join(paths.current, 'bundle.json'));
      if (!await manifestFile.exists()) continue;
      final BundleManifest manifest;
      try {
        manifest =
            BundleManifest.parse(jsonDecode(await manifestFile.readAsString()));
      } catch (error) {
        stdout.writeln(
            'provisioner: skip $appId — unreadable current/bundle.json: $error');
        continue;
      }
      if (manifest.backend == null) continue;
      if (_instances.containsKey(appId)) continue;
      stdout.writeln(
          'provisioner: restore $appId v${manifest.versionCode}');
      final StartResult result = await start(appId, manifest);
      if (result.ok) {
        started += 1;
      } else {
        stdout.writeln(
            'provisioner: restore $appId failed — ${result.error} '
            '(dir stays; next install/upgrade replaces it)');
      }
    }
    return started;
  }
}
