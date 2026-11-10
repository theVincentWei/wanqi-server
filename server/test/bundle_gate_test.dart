// Bundle v1 gate tests — every rule from task-1 / spec §5①, against zips
// built in memory (no server, no DB).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:apphub/bundle.dart';
import 'package:archive/archive.dart';
import 'package:test/test.dart';

/// Builds an in-memory zip whose regular files are [files] (path → text).
Uint8List zipOf(Map<String, String> files) {
  final Archive archive = Archive();
  files.forEach((String name, String content) {
    final List<int> bytes = utf8.encode(content);
    archive.addFile(ArchiveFile(name, bytes.length, bytes));
  });
  return Uint8List.fromList(ZipEncoder().encode(archive)!);
}

/// Decodes [bytes] back into an [Archive] the way the server endpoint does.
Archive archiveOf(Uint8List bytes) => ZipDecoder().decodeBytes(bytes, verify: true);

Map<String, String> goodFiles({
  String? bundleJson,
  bool backend = false,
  String? projectConfigAppid,
}) {
  final String manifest = bundleJson ??
      jsonEncode(<String, Object?>{
        'spec': 1,
        'appId': 'wanqi-test-app',
        'name': '测试应用',
        'version': <String, Object?>{'code': 1, 'name': '0.0.1'},
        'frontend': <String, Object?>{'entry': 'pages/index/index'},
        if (backend)
          'backend': <String, Object?>{
            'start': 'node dist/main.js',
            'health': '/healthz',
            'gateway': <String>['/'],
            'ai': false,
          },
      });
  return <String, String>{
    'bundle.json': manifest,
    'main/app-config.json': '{"app":{}}',
    'main/logic.js': 'console.log(1)',
    if (backend) 'backend/dist/main.js': 'console.log("backend")',
    if (projectConfigAppid != null)
      'project.config.json': jsonEncode(<String, Object?>{'appid': projectConfigAppid}),
  };
}

void main() {
  group('bundle.json presence/parse', () {
    test('missing bundle.json is rejected (old-format packages die here)', () {
      final Archive archive = archiveOf(zipOf(<String, String>{
        'main/app-config.json': '{}',
        'main/logic.js': '',
      }));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('bundle.json missing'));
    });

    test('malformed bundle.json JSON is rejected', () {
      final Archive archive =
          archiveOf(zipOf(goodFiles(bundleJson: '{not json')));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('non-object bundle.json is rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(bundleJson: '[1,2]')));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });
  });

  group('spec evolution rule', () {
    test('spec 1 is accepted', () {
      final Archive archive = archiveOf(zipOf(goodFiles()));
      expect(gateBundle(archive, zipBytes: 100).rejected, isFalse);
    });

    test('spec higher than supported is rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(bundleJson:
          jsonEncode(<String, Object?>{'spec': 2, 'appId': 'wanqi-test-app'}))));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('newer than supported'));
    });

    test('spec must be an integer', () {
      final Archive archive = archiveOf(zipOf(goodFiles(bundleJson:
          jsonEncode(<String, Object?>{'appId': 'wanqi-test-app'}))));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('unknown fields are ignored (spec §3)', () {
      final Archive archive = archiveOf(zipOf(goodFiles(bundleJson:
          jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1, 'name': '1'},
            'frontend': <String, Object?>{'entry': 'pages/index/index'},
            'unknownTopLevel': <String>['a', 'b'],
            'future': <String, Object?>{'anything': true},
          }))));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.appId, 'wanqi-test-app');
    });
  });

  group('identity fields', () {
    test('invalid appId rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'Bad AppID!',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'pages/index/index'},
          }))));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('empty name rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': '  ',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'p'},
          }))));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('version.code must be a positive integer', () {
      for (final Object? code in <Object?>[0, -1, '1', 1.5, null]) {
        final Archive archive = archiveOf(zipOf(goodFiles(
            bundleJson: jsonEncode(<String, Object?>{
              'spec': 1,
              'appId': 'wanqi-test-app',
              'name': 'x',
              'version': <String, Object?>{'code': code},
              'frontend': <String, Object?>{'entry': 'p'},
            }))));
        expect(gateBundle(archive, zipBytes: 100).rejected, isTrue,
            reason: 'code=$code must be rejected');
      }
    });

    test('missing frontend.entry rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
          }))));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('version.name defaults to 0.0.<code>', () {
      final Archive archive = archiveOf(zipOf(goodFiles()));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.versionName, '0.0.1');
    });
  });

  group('frontend slice', () {
    test('missing main/ files is rejected', () {
      final Archive archive = archiveOf(zipOf(<String, String>{
        'bundle.json': goodFiles()['bundle.json']!,
        'main/app-config.json': '{}',
      }));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('main/app-config.json'));
    });
  });

  group('zip safety', () {
    test('oversized zip rejected (10 MiB cap)', () {
      final Archive archive = archiveOf(zipOf(goodFiles()));
      final BundleGateResult gate =
          gateBundle(archive, zipBytes: 10 * 1024 * 1024 + 1);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('limit'));
    });

    test('.node native extension rejected anywhere in the package', () {
      final Archive archive = Archive()
        ..addFile(ArchiveFile('bundle.json', 0,
            utf8.encode(goodFiles()['bundle.json']!)))
        ..addFile(ArchiveFile('main/app-config.json', 2, utf8.encode('{}')))
        ..addFile(ArchiveFile('main/logic.js', 0, <int>[]))
        ..addFile(ArchiveFile('backend/native.node', 3, <int>[1, 2, 3]));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('.node'));
    });

    test('path traversal entry rejected', () {
      final Archive archive = Archive()
        ..addFile(ArchiveFile('bundle.json', 0,
            utf8.encode(goodFiles()['bundle.json']!)))
        ..addFile(ArchiveFile('main/app-config.json', 2, utf8.encode('{}')))
        ..addFile(ArchiveFile('main/logic.js', 0, <int>[]))
        ..addFile(
            ArchiveFile('backend/../../evil.js', 1, <int>[0x78]));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('unsafe zip entry'));
    });

    test('unpacked content over 64 MiB rejected', () {
      final Archive archive = Archive()
        ..addFile(ArchiveFile('bundle.json', 0,
            utf8.encode(goodFiles()['bundle.json']!)))
        ..addFile(ArchiveFile('main/app-config.json', 2, utf8.encode('{}')))
        ..addFile(ArchiveFile('main/logic.js', 0, <int>[]))
        // Reported size is what the cap counts — no need to materialise 65MB.
        ..addFile(ArchiveFile('backend/blob.bin', 65 * 1024 * 1024, <int>[1]));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('64 MiB'));
    });
  });

  group('appId consistency (project.config.json)', () {
    test('matching appid accepted', () {
      final Archive archive =
          archiveOf(zipOf(goodFiles(projectConfigAppid: 'wanqi-test-app')));
      expect(gateBundle(archive, zipBytes: 100).rejected, isFalse);
    });

    test('mismatching appid rejected', () {
      final Archive archive =
          archiveOf(zipOf(goodFiles(projectConfigAppid: 'wx0000000000000000')));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('does not match bundle.json'));
    });

    test('absent project.config.json accepted (published zips do not ship it)',
        () {
      final Archive archive = archiveOf(zipOf(goodFiles()));
      expect(gateBundle(archive, zipBytes: 100).rejected, isFalse);
    });
  });

  group('versionCode strictly increases (upgrades only)', () {
    Archive at(int code) => archiveOf(zipOf(goodFiles(bundleJson:
        jsonEncode(<String, Object?>{
          'spec': 1,
          'appId': 'wanqi-test-app',
          'name': 'x',
          'version': <String, Object?>{'code': code},
          'frontend': <String, Object?>{'entry': 'p'},
        }))));

    test('first install accepts any positive code', () {
      expect(gateBundle(at(1), zipBytes: 100).rejected, isFalse);
      expect(gateBundle(at(99), zipBytes: 100).rejected, isFalse);
    });

    test('regression rejected with 409', () {
      final BundleGateResult gate =
          gateBundle(at(9), zipBytes: 100, latestVersionCode: 10);
      expect(gate.rejected, isTrue);
      expect(gate.statusCode, 409);
    });

    test('same code rejected on upgrade', () {
      final BundleGateResult gate =
          gateBundle(at(10), zipBytes: 100, latestVersionCode: 10);
      expect(gate.rejected, isTrue);
      expect(gate.statusCode, 409);
    });

    test('increased code accepted on upgrade', () {
      expect(gateBundle(at(11), zipBytes: 100, latestVersionCode: 10).rejected,
          isFalse);
    });
  });

  group('backend.start entry file', () {
    test('existing entry file accepted', () {
      final Archive archive = archiveOf(zipOf(goodFiles(backend: true)));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.backend!.start, 'node dist/main.js');
    });

    test('missing entry file rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(backend: true)
          ..remove('backend/dist/main.js')));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('backend/dist/main.js'));
    });

    test('start without any file token rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'p'},
            'backend': <String, Object?>{'start': 'npm start'},
          }))));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('names no entry file'));
    });

    test('flags are skipped when hunting the entry file', () {
      final Archive archive = archiveOf(zipOf(goodFiles(bundleJson:
          jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'p'},
            'backend': <String, Object?>{
              'start': 'node --experimental ./daemon/main.js',
            },
          }))
            ..['backend/daemon/main.js'] = 'console.log(1)'));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
    });

    test('backend section without start rejected', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'p'},
            'backend': <String, Object?>{'health': '/healthz'},
          }))));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('health path must start with / when present', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'p'},
            'backend': <String, Object?>{
              'start': 'node dist/main.js',
              'health': 'healthz',
            },
          }))
            ..['backend/dist/main.js'] = 'x'));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('gateway prefixes must start with /', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(<String, Object?>{
            'spec': 1,
            'appId': 'wanqi-test-app',
            'name': 'x',
            'version': <String, Object?>{'code': 1},
            'frontend': <String, Object?>{'entry': 'p'},
            'backend': <String, Object?>{
              'start': 'node dist/main.js',
              'gateway': <String>['v1'],
            },
          }))
            ..['backend/dist/main.js'] = 'x'));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('empty/absent gateway defaults to ["/"]', () {
      for (final Object? gateway in <Object?>[
        null,
        <String>[],
      ]) {
        final Archive archive = archiveOf(zipOf(goodFiles(
            bundleJson: jsonEncode(<String, Object?>{
              'spec': 1,
              'appId': 'wanqi-test-app',
              'name': 'x',
              'version': <String, Object?>{'code': 1},
              'frontend': <String, Object?>{'entry': 'p'},
              'backend': <String, Object?>{
                'start': 'node dist/main.js',
                if (gateway != null) 'gateway': gateway,
              },
            }))
              ..['backend/dist/main.js'] = 'x'));
        final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
        expect(gate.rejected, isFalse, reason: 'gateway=$gateway');
        expect(gate.manifest!.backend!.gateway, <String>['/']);
      }
    });
  });

  group('pure frontend bundles', () {
    test('no backend section → backend null, accepted', () {
      final Archive archive = archiveOf(zipOf(goodFiles()));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.backend, isNull);
    });
  });

  group('backendStartEntry token hunting', () {
    test('finds the package file among runtime/flags/subcommands', () {
      expect(backendStartEntry('node dist/main.js'), 'dist/main.js');
      expect(backendStartEntry('node --harmony -x daemon/main.mjs'),
          'daemon/main.mjs');
      expect(backendStartEntry('./start.sh'), 'start.sh');
      expect(backendStartEntry('python3 job/run.py'), 'job/run.py');
      expect(backendStartEntry('npm start'), isNull);
      expect(backendStartEntry('node serve'), isNull);
    });
  });
}
