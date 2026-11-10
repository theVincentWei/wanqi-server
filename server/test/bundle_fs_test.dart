// Backend dir lifecycle tests (Bundle v1 §4/§5③/§6): install/upgrade/
// rollback/remove against temp dirs. Pure fs — no server, no DB.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:apphub/bundle.dart';
import 'package:apphub/bundle_fs.dart';
import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

Archive bundleArchive({
  required int code,
  required bool backend,
  String start = 'node dist/main.js',
  List<ArchiveFile>? extra,
}) {
  final Archive archive = Archive();
  final Map<String, Object?> manifest = <String, Object?>{
    'spec': 1,
    'appId': 'wanqi-test-app',
    'name': '测试应用',
    'version': <String, Object?>{'code': code, 'name': '0.0.$code'},
    'frontend': <String, Object?>{'entry': 'pages/index/index'},
    if (backend)
      'backend': <String, Object?>{
        'start': start,
        'health': '/healthz',
        'gateway': <String>['/'],
      },
  };
  void add(String name, String content) {
    final List<int> bytes = utf8.encode(content);
    archive.addFile(ArchiveFile(name, bytes.length, bytes));
  }

  add('bundle.json', jsonEncode(manifest));
  add('main/app-config.json', '{"app":{}}');
  add('main/logic.js', 'console.log($code)');
  if (backend) {
    final String entry =
        start.contains(' ') ? start.split(' ').last.replaceFirst('./', '') : 'main.js';
    add('backend/$entry', 'console.log("backend v$code")');
    add('backend/package.json', '{"name":"daemon"}');
  }
  for (final ArchiveFile file in extra ?? <ArchiveFile>[]) {
    archive.addFile(file);
  }
  return archive;
}

Future<BundleManifest> installAt(
  Directory backends, {
  required int code,
  bool backend = true,
}) async {
  final Archive archive = bundleArchive(code: code, backend: backend);
  final BundleManifest manifest =
      BundleManifest.parse(jsonDecode(utf8.decode(
          Uint8List.fromList(bundleEntry(archive, 'bundle.json')!.content as List<int>))));
  await installBackendDir(
      archive: archive, manifest: manifest, backendsRoot: backends.path);
  return manifest;
}

void main() {
  late Directory backends;

  setUp(() async {
    backends = await Directory.systemTemp.createTemp('wanqi-backends-test-');
  });

  tearDown(() async {
    if (await backends.exists()) await backends.delete(recursive: true);
  });

  group('installBackendDir', () {
    test('creates current/ + data/ + logs/, writes the backend slice', () async {
      await installAt(backends, code: 1);
      final BackendPaths paths = BackendPaths(p.join(backends.path, 'wanqi-test-app'));
      expect(paths.exists, isTrue);
      expect(await File(p.join(paths.current, 'dist', 'main.js')).exists(), isTrue);
      expect(await File(p.join(paths.current, 'package.json')).exists(), isTrue);
      // The manifest describing this code dir rides along.
      expect(await File(p.join(paths.current, 'bundle.json')).exists(), isTrue);
      // main/ (frontend slice) must not land in the backend dir.
      expect(await File(p.join(paths.current, 'app-config.json')).exists(), isFalse);
      expect(await Directory(paths.data).exists(), isTrue);
      expect(await Directory(paths.logs).exists(), isTrue);
    });

    test('upgrade rotates current/ → previous/, data/logs untouched', () async {
      await installAt(backends, code: 1);
      final BackendPaths paths = BackendPaths(p.join(backends.path, 'wanqi-test-app'));
      // Write a data marker before upgrading — it must survive.
      final File marker = File(p.join(paths.data, 'state.json'));
      await marker.writeAsString('{"hp":100}');

      await installAt(backends, code: 2);

      expect(await File(p.join(paths.previous, 'dist', 'main.js')).exists(), isTrue);
      final String prevManifest =
          await File(p.join(paths.previous, 'bundle.json')).readAsString();
      expect(prevManifest, contains('"code":1'));
      final String curManifest =
          await File(p.join(paths.current, 'bundle.json')).readAsString();
      expect(curManifest, contains('"code":2'));
      expect(await marker.exists(), isTrue);
      expect(await marker.readAsString(), '{"hp":100}');
    });

    test('symlink entries are rejected', () async {
      final Archive archive = bundleArchive(code: 1, backend: true);
      final ArchiveFile link = ArchiveFile('backend/evil.link', 0, <int>[])
        ..isSymbolicLink = true
        ..nameOfLinkedFile = '/etc/passwd';
      archive.addFile(link);
      final BundleManifest manifest =
          BundleManifest.parse(jsonDecode(utf8.decode(
              Uint8List.fromList(
                  bundleEntry(archive, 'bundle.json')!.content as List<int>))));
      await expectLater(
          installBackendDir(
              archive: archive, manifest: manifest, backendsRoot: backends.path),
          throwsA(isA<BackendFsException>()));
    });

    test('traversal entries cannot escape current/', () async {
      final Archive archive = bundleArchive(code: 1, backend: true)
        ..addFile(ArchiveFile('backend/../escape.js', 2, utf8.encode('x')));
      final BundleManifest manifest =
          BundleManifest.parse(jsonDecode(utf8.decode(
              Uint8List.fromList(
                  bundleEntry(archive, 'bundle.json')!.content as List<int>))));
      // The gate rejects traversal zips outright, but the fs layer must stand
      // alone too.
      await expectLater(
          installBackendDir(
              archive: archive, manifest: manifest, backendsRoot: backends.path),
          throwsA(isA<BackendFsException>()));
      expect(
          await File(p.join(backends.path, 'escape.js')).exists(), isFalse);
    });
  });

  group('rollbackBackendDir', () {
    test('swaps current ↔ previous', () async {
      await installAt(backends, code: 1);
      await installAt(backends, code: 2);
      final BackendPaths paths = BackendPaths(p.join(backends.path, 'wanqi-test-app'));

      await rollbackBackendDir(paths);

      final String curManifest =
          await File(p.join(paths.current, 'bundle.json')).readAsString();
      expect(curManifest, contains('"code":1'));
      final String prevManifest =
          await File(p.join(paths.previous, 'bundle.json')).readAsString();
      expect(prevManifest, contains('"code":2'));
    });

    test('double rollback returns to the newest', () async {
      await installAt(backends, code: 1);
      await installAt(backends, code: 2);
      final BackendPaths paths = BackendPaths(p.join(backends.path, 'wanqi-test-app'));
      await rollbackBackendDir(paths);
      await rollbackBackendDir(paths);
      expect(
          await File(p.join(paths.current, 'bundle.json')).readAsString(),
          contains('"code":2'));
    });

    test('throws when there is no previous', () async {
      await installAt(backends, code: 1);
      final BackendPaths paths = BackendPaths(p.join(backends.path, 'wanqi-test-app'));
      await expectLater(
          rollbackBackendDir(paths), throwsA(isA<BackendFsException>()));
    });
  });

  group('removeBackendDirs', () {
    test('deletes code dirs, keeps data/logs', () async {
      await installAt(backends, code: 1);
      final BackendPaths paths = BackendPaths(p.join(backends.path, 'wanqi-test-app'));
      final File marker = File(p.join(paths.data, 'state.json'));
      await marker.writeAsString('{}');

      await removeBackendDirs(paths);

      expect(await Directory(paths.current).exists(), isFalse);
      expect(await Directory(paths.previous).exists(), isFalse);
      expect(await marker.exists(), isTrue);
      expect(await Directory(paths.logs).exists(), isTrue);
    });

    test('pure-frontend app (never installed) removes cleanly', () async {
      final BackendPaths paths =
          BackendPaths(p.join(backends.path, 'wanqi-never-installed'));
      await removeBackendDirs(paths); // must not throw
      expect(paths.exists, isFalse);
    });
  });
}
