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

  group('autoSync(万器扩展,缺省 false)', () {
    Object manifestWith(Object? autoSync) => <String, Object?>{
          'spec': 1,
          'appId': 'wanqi-test-app',
          'name': 'x',
          'version': <String, Object?>{'code': 1},
          'frontend': <String, Object?>{'entry': 'p'},
          if (autoSync != null) 'autoSync': autoSync,
        };

    test('缺省 false', () {
      final Archive archive =
          archiveOf(zipOf(goodFiles(bundleJson: jsonEncode(manifestWith(null)))));
      expect(gateBundle(archive, zipBytes: 100).manifest!.autoSync, isFalse);
    });

    test('true/false 透传', () {
      final Archive on = archiveOf(
          zipOf(goodFiles(bundleJson: jsonEncode(manifestWith(true)))));
      expect(gateBundle(on, zipBytes: 100).manifest!.autoSync, isTrue);
      final Archive off = archiveOf(
          zipOf(goodFiles(bundleJson: jsonEncode(manifestWith(false)))));
      expect(gateBundle(off, zipBytes: 100).manifest!.autoSync, isFalse);
    });

    test('非 bool 值按 false 处理(R1 忽略口径),不拒装', () {
      final Archive archive = archiveOf(
          zipOf(goodFiles(bundleJson: jsonEncode(manifestWith('yes')))));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.autoSync, isFalse);
    });
  });

  group('backend.tools 声明(声明即接入)', () {
    Map<String, Object?> backendWith(Object? tools) =>
        <String, Object?>{
          'start': 'node dist/main.js',
          'health': '/healthz',
          'gateway': <String>['/'],
          'ai': false,
          if (tools != null) 'tools': tools,
        };

    Object? manifestWithBackend(Object? tools) => <String, Object?>{
          'spec': 1,
          'appId': 'wanqi-test-app',
          'name': '测试应用',
          'version': <String, Object?>{'code': 1, 'name': '0.0.1'},
          'frontend': <String, Object?>{'entry': 'pages/index/index'},
          'backend': backendWith(tools),
        };

    final Map<String, Object?> goodTools = <String, Object?>{
      'tools': <Object?>[
        <String, Object?>{
          'name': 'get_entries',
          'method': 'GET',
          'path': '/api/entries',
          'description': '列出全部条目',
          'params': <String, Object?>{
            'type': 'object',
            'properties': <String, Object?>{
              'limit': <String, Object?>{'type': 'integer'},
            },
          },
        },
      ],
    };

    test('合法声明随包通过,toolsJson 可编码', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(manifestWithBackend(goodTools)),
          backend: true)));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      final BundleBackend? backend = gate.manifest!.backend;
      expect(backend, isNotNull);
      expect(backend!.tools, isNotNull);
      expect(backend.toolsJson, contains('get_entries'));
    });

    test('无 tools 段 = 不暴露,toolsJson 为 null', () {
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(manifestWithBackend(null)), backend: true)));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.backend!.toolsJson, isNull);
    });

    test('坏声明拒装:工具名非 snake_case', () {
      final Object? bad = <String, Object?>{
        'tools': <Object?>[
          <String, Object?>{'name': 'Get-Entries', 'method': 'GET', 'path': '/x'},
        ],
      };
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(manifestWithBackend(bad)), backend: true)));
      final BundleGateResult gate = gateBundle(archive, zipBytes: 100);
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('backend.tools'));
    });

    test('坏声明拒装:method 不在 GET/POST/PUT/DELETE', () {
      final Object? bad = <String, Object?>{
        'tools': <Object?>[
          <String, Object?>{'name': 'fetch_all', 'method': 'PATCH', 'path': '/x'},
        ],
      };
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(manifestWithBackend(bad)), backend: true)));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('坏声明拒装:params 非 JSON schema 对象', () {
      final Object? bad = <String, Object?>{
        'tools': <Object?>[
          <String, Object?>{'name': 'fetch_all', 'path': '/x', 'params': 'limit=10'},
        ],
      };
      final Archive archive = archiveOf(zipOf(goodFiles(
          bundleJson: jsonEncode(manifestWithBackend(bad)), backend: true)));
      expect(gateBundle(archive, zipBytes: 100).rejected, isTrue);
    });

    test('共享校验器与市场发布端点同源(validateToolsManifest)', () {
      expect(validateToolsManifest(goodTools), isNull);
      expect(validateToolsManifest(<String, Object?>{'tools': 'nope'}),
          contains('must be an object with a "tools" array'));
    });
  });

  group('permissions 声明段(契约 §2,严式校验)', () {
    Object manifestWith(Object? permissions) => <String, Object?>{
          'spec': 1,
          'appId': 'wanqi-test-app',
          'name': '测试应用',
          'version': <String, Object?>{'code': 1, 'name': '0.0.1'},
          'frontend': <String, Object?>{'entry': 'pages/index/index'},
          if (permissions != null) 'permissions': permissions,
        };

    BundleGateResult gateWith(Object? permissions) => gateBundle(
        archiveOf(
            zipOf(goodFiles(bundleJson: jsonEncode(manifestWith(permissions))))),
        zipBytes: 100);

    test('缺段=合法(纯展示 app 零改动零发版)', () {
      final BundleGateResult gate = gateWith(null);
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.permissions, isNull);
      expect(gate.manifest!.permissionsJson, isNull);
    });

    test('空段归一为未声明:permissionsJson 为 null', () {
      final BundleGateResult gate = gateWith(<String, Object?>{});
      expect(gate.rejected, isFalse);
      expect(gate.manifest!.permissionsJson, isNull);
    });

    test('合法段(scopes+network)通过,permissionsJson 可编码', () {
      final BundleGateResult gate = gateWith(<String, Object?>{
        'scopes': <Object?>[
          <String, Object?>{
            'scope': 'scope.record',
            'desc': '录音测试需要麦克风',
          },
        ],
        'network': <String, Object?>{
          'domains': <String>['https://open.bigmodel.cn'],
        },
      });
      expect(gate.rejected, isFalse);
      final BundlePermissions permissions = gate.manifest!.permissions!;
      expect(permissions.scopes.single.scope, 'scope.record');
      expect(permissions.scopes.single.desc, '录音测试需要麦克风');
      expect(permissions.domains, <String>['https://open.bigmodel.cn']);
      expect(gate.manifest!.permissionsJson, contains('scope.record'));
    });

    test('目录内全部 scope 声明合法(userLocation 声明合法,容器 v1 诚实 not supported)', () {
      for (final String scope in bundleScopeCatalog.keys) {
        final BundleGateResult gate = gateWith(<String, Object?>{
          'scopes': <Object?>[
            <String, Object?>{'scope': scope, 'desc': '测试'},
          ],
        });
        expect(gate.rejected, isFalse, reason: 'scope=$scope must be accepted');
      }
    });

    test('未知 scope 拒装(400)', () {
      final BundleGateResult gate = gateWith(<String, Object?>{
        'scopes': <Object?>[
          <String, Object?>{'scope': 'scope.userAlbums', 'desc': 'x'},
        ],
      });
      expect(gate.rejected, isTrue);
      expect(gate.error, contains('unknown scope'));
      expect(gate.statusCode, 400);
    });

    test('缺 desc / 空 desc / 空白 desc / 非 string desc 拒装', () {
      for (final Object? desc in <Object?>[null, '', '   ', 42]) {
        final BundleGateResult gate = gateWith(<String, Object?>{
          'scopes': <Object?>[
            <String, Object?>{
              'scope': 'scope.record',
              if (desc != null) 'desc': desc,
            },
          ],
        });
        expect(gate.rejected, isTrue, reason: 'desc=$desc must be rejected');
        expect(gate.error, contains('non-empty'));
      }
    });

    test('坏域名拒装:无 scheme/非 http(s)/无 host/垃圾串/非 string', () {
      for (final Object? domain in <Object?>[
        'open.bigmodel.cn',
        'ftp://open.bigmodel.cn',
        'https://',
        'not a url',
        123,
      ]) {
        final BundleGateResult gate = gateWith(<String, Object?>{
          'network': <String, Object?>{
            'domains': <Object?>[domain],
          },
        });
        expect(gate.rejected, isTrue, reason: 'domain=$domain must be rejected');
        expect(gate.error, contains('http(s)'));
      }
    });

    test('合法域名形态:裸 origin、带 path、带端口都收', () {
      for (final String domain in <String>[
        'https://open.bigmodel.cn',
        'https://api.example.com/v1',
        'http://api.example.com:8080',
      ]) {
        final BundleGateResult gate = gateWith(<String, Object?>{
          'network': <String, Object?>{
            'domains': <String>[domain],
          },
        });
        expect(gate.rejected, isFalse, reason: 'domain=$domain');
      }
    });

    test('形状坏一律拒装:permissions 非 object/scopes 非 list/条目非 object/network 非 object/domains 非 list', () {
      final List<Object?> bad = <Object?>[
        <String>['nope'],
        <String, Object?>{'scopes': 'record'},
        <String, Object?>{'scopes': <Object?>['scope.record']},
        <String, Object?>{'network': <String>['https://x.cn']},
        <String, Object?>{
          'network': <String, Object?>{'domains': 'https://x.cn'},
        },
      ];
      for (final Object? permissions in bad) {
        final BundleGateResult gate = gateWith(permissions);
        expect(gate.rejected, isTrue,
            reason: 'permissions=$permissions must be rejected');
      }
    });

    test('市场透传形态:scopes[].{key,title,usage,mode} + network.domains,重复 scope 去重保留首条', () {
      final Map<String, Object?> shaped = permissionsForMarket(jsonEncode(
          <String, Object?>{
            'scopes': <Object?>[
              <String, Object?>{
                'scope': 'scope.record',
                'desc': '录音测试需要麦克风',
              },
              <String, Object?>{
                'scope': 'scope.record',
                'desc': '重复条目',
              },
              <String, Object?>{'scope': 'scope.contacts', 'desc': '加联系人'},
            ],
            'network': <String, Object?>{
              'domains': <String>['https://open.bigmodel.cn'],
            },
          }))!;
      expect(shaped.keys, containsAll(<String>['scopes', 'network']));
      final List<Object?> scopes = shaped['scopes'] as List<Object?>;
      expect(scopes.length, 2);
      final Map<String, Object?> record = scopes.first as Map<String, Object?>;
      expect(record['key'], 'scope.record');
      expect(record['title'], '麦克风/录音');
      expect(record['usage'], '录音测试需要麦克风');
      expect(record['mode'], '授权级');
      final Map<String, Object?> contacts = scopes.last as Map<String, Object?>;
      expect(contacts['key'], 'scope.contacts');
      expect(contacts['mode'], '声明级');
      expect((shaped['network'] as Map<String, Object?>)['domains'],
          <String>['https://open.bigmodel.cn']);
    });

    test('占位级 scope 透传 mode=占位级(契约 §1 三级分级)', () {
      final Map<String, Object?> shaped = permissionsForMarket(jsonEncode(
          <String, Object?>{
            'scopes': <Object?>[
              <String, Object?>{'scope': 'scope.camera', 'desc': '拍照'},
            ],
          }))!;
      expect(
          ((shaped['scopes'] as List<Object?>).single as Map<String, Object?>)[
              'mode'],
          '占位级');
    });

    test('无声明/垃圾落库 JSON → null(市场端渲染为无声明)', () {
      expect(permissionsForMarket(null), isNull);
      expect(permissionsForMarket(''), isNull);
      expect(permissionsForMarket('{not json'), isNull);
      expect(permissionsForMarket('[]'), isNull);
      expect(
          permissionsForMarket(jsonEncode(<String, Object?>{
            'scopes': <Object?>[],
            'network': <String, Object?>{'domains': <String>[]},
          })),
          isNull);
    });

    test('isValidExternalDomain:scheme http/https + 非空 host', () {
      expect(isValidExternalDomain('https://open.bigmodel.cn'), isTrue);
      expect(isValidExternalDomain('http://127.0.0.1:7610'), isTrue);
      expect(isValidExternalDomain('open.bigmodel.cn'), isFalse);
      expect(isValidExternalDomain(''), isFalse);
    });
  });
}
