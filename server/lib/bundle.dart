/// Bundle v1 — the zip contract (`design-bundle-spec.md` §1–§5):
///
/// ```
/// <app>.bundle.zip
/// ├── bundle.json   # required manifest — old-format zips without it are rejected
/// ├── store.json    # optional market copy (handled by the publish path)
/// ├── main/         # required frontend (DMCC output)
/// └── backend/      # optional backend slice, deps bundled, no network at install
/// ```
///
/// This library owns the pure, testable half: manifest parsing and the
/// install gate. The filesystem half (unpack/rollback/remove) lives in
/// bundle_fs.dart; the HTTP endpoints in BundleService wire them together.
///
/// Spec evolution rule (§3): consumers ignore unknown fields; a `spec` newer
/// than what we support is rejected.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

import 'store.dart' show isValidAppId;

/// Highest bundle spec this server understands.
const int supportedBundleSpec = 1;

/// Hard cap on the bundle zip itself (§4: deps ship in-package, so the whole
/// install stays offline and bounded).
const int maxBundleBytes = 10 * 1024 * 1024;

/// Cap on total uncompressed content — the zip-bomb guard for the unpacker.
const int maxUnpackedBytes = 64 * 1024 * 1024;

/// Route target recorded at install time, before a backend process exists.
/// Task-4 (provisioning) rewrites it with the dynamically assigned port at
/// spawn; until then the gateway answers 502 for these prefixes.
const String bundleRoutePlaceholder = 'http://127.0.0.1:0';

/// A gate failure. [statusCode] is what the install endpoint answers with —
/// version regressions are conflicts (409), everything else is a bad package
/// (400).
class BundleException implements Exception {
  BundleException(this.message, {this.statusCode = 400});

  final String message;
  final int statusCode;

  @override
  String toString() => message;
}

/// The `backend` section of bundle.json. Absent section = pure frontend app.
class BundleBackend {
  const BundleBackend({
    required this.start,
    required this.health,
    required this.gateway,
    required this.ai,
    this.tools,
  });

  /// Start command; cwd is the unpacked `backend/` dir (§3).
  final String start;

  /// Health path probed after spawn (§5④). Empty = no probe defined.
  final String health;

  /// Gateway prefixes auto-registered in the routes table at install (§5⑤).
  final List<String> gateway;

  /// Whether the backend talks to the AI gateway.
  final bool ai;

  /// Optional tools manifest (声明即接入): the backend's agent-facing HTTP
  /// surface, validated by [validateToolsManifest] at parse time and stored
  /// on the version row at install. Null = the backend is not exposed to
  /// the agent. Raw decoded JSON; [toolsJson] is the stored encoding.
  final Object? tools;

  /// The tools manifest encoded for `app_versions.tools_json`, or null.
  String? get toolsJson => tools == null ? null : jsonEncode(tools);
}

/// Validates the tools manifest (OpenAPI subset) a bundle declares under
/// `backend.tools` or a publish attaches via `x-tools-b64`: the single
/// source of truth the DSH tool registrar (wanqi-mcp-bridge) registers from.
/// Returns a problem description, or null when the manifest is acceptable.
String? validateToolsManifest(Object? decoded) {
  if (decoded == null) return null;
  if (decoded is! Map<String, Object?> || decoded['tools'] is! List) {
    return 'tools must be an object with a "tools" array';
  }
  final List<dynamic> tools = decoded['tools'] as List<dynamic>;
  for (final dynamic tool in tools) {
    if (tool is! Map<String, Object?>) return 'each tool must be an object';
    final String name = tool['name'] as String? ?? '';
    final String method = (tool['method'] as String? ?? 'GET').toUpperCase();
    final String path = tool['path'] as String? ?? '';
    if (!RegExp(r'^[a-z][a-z0-9_]{1,40}$').hasMatch(name)) {
      return 'tool name "$name" must be snake_case';
    }
    if (!<String>['GET', 'POST', 'PUT', 'DELETE'].contains(method)) {
      return 'tool "$name": method must be GET/POST/PUT/DELETE';
    }
    if (!path.startsWith('/')) return 'tool "$name": path must start with /';
    final Object? params = tool['params'];
    if (params != null && params is! Map<String, Object?>) {
      return 'tool "$name": params must be a JSON schema object';
    }
    final Object? description = tool['description'];
    if (description != null && description is! String) {
      return 'tool "$name": description must be a string';
    }
  }
  return null;
}

/// A parsed bundle.json. Only the fields the server consumes live here;
/// unknown fields are dropped by design (§3 evolution rule).
class BundleManifest {
  const BundleManifest({
    required this.spec,
    required this.appId,
    required this.name,
    required this.versionCode,
    required this.versionName,
    required this.frontendEntry,
    required this.backend,
    this.autoSync = false,
  });

  final int spec;
  final String appId;
  final String name;
  final int versionCode;
  final String versionName;

  /// Startup page — the single source for the market row's `path` (§3).
  final String frontendEntry;

  /// Null = pure frontend app (no backend dir, no routes).
  final BundleBackend? backend;

  /// autoSync 静默同步(万器扩展,R1 演进规则安全:老 server 按未知字段忽略,
  /// 缺省 false)。true = 手机宿主可在后台静默安装/升级这个 app,不弹确认。
  final bool autoSync;

  /// Parses decoded bundle.json, throwing [BundleException] on anything the
  /// server cannot safely consume.
  factory BundleManifest.parse(Object? decoded) {
    if (decoded is! Map<String, Object?>) {
      throw BundleException('bundle.json must be a JSON object');
    }
    final Object? rawSpec = decoded['spec'];
    if (rawSpec is! int) {
      throw BundleException('bundle.json "spec" must be an integer');
    }
    if (rawSpec > supportedBundleSpec) {
      throw BundleException(
          'bundle spec $rawSpec is newer than supported spec $supportedBundleSpec — '
          'upgrade the server or rebuild with spec ≤ $supportedBundleSpec');
    }
    final String appId = decoded['appId'] as String? ?? '';
    if (!isValidAppId(appId)) {
      throw BundleException(
          'bundle.json "appId" "$appId" is invalid (lowercase letters, digits, hyphens)');
    }
    final String name = decoded['name'] as String? ?? '';
    if (name.trim().isEmpty) {
      throw BundleException('bundle.json "name" must be a non-empty string');
    }
    final Object? rawVersion = decoded['version'];
    if (rawVersion is! Map<String, Object?>) {
      throw BundleException('bundle.json "version" must be an object');
    }
    final Object? rawCode = rawVersion['code'];
    if (rawCode is! int || rawCode < 1) {
      throw BundleException('bundle.json "version.code" must be a positive integer');
    }
    final String versionName =
        rawVersion['name'] as String? ?? '0.0.$rawCode';
    final String entry = decoded['frontend'] is Map<String, Object?>
        ? ((decoded['frontend'] as Map<String, Object?>)['entry'] as String? ?? '')
        : '';
    if (entry.isEmpty) {
      throw BundleException('bundle.json "frontend.entry" must be a non-empty string');
    }
    return BundleManifest(
      spec: rawSpec,
      appId: appId,
      name: name.trim(),
      versionCode: rawCode,
      versionName: versionName,
      frontendEntry: entry,
      backend: _parseBackend(decoded['backend']),
      // 万器扩展:autoSync(顶层可选 bool,缺省 false;非 bool 值按 false 处理,
      // 与 spec R1「未知/坏字段忽略」同口径)。
      autoSync: decoded['autoSync'] is bool ? decoded['autoSync'] as bool : false,
    );
  }

  static BundleBackend? _parseBackend(Object? raw) {
    if (raw == null) return null;
    if (raw is! Map<String, Object?>) {
      throw BundleException('bundle.json "backend" must be an object');
    }
    final String start = raw['start'] as String? ?? '';
    if (start.trim().isEmpty) {
      throw BundleException(
          'bundle.json "backend.start" must be a non-empty command (cwd = backend/)');
    }
    final String health = raw['health'] as String? ?? '';
    if (health.isNotEmpty && !health.startsWith('/')) {
      throw BundleException('bundle.json "backend.health" must start with /');
    }
    final Object? rawGateway = raw['gateway'];
    List<String> gateway = const <String>['/'];
    if (rawGateway != null) {
      if (rawGateway is! List ||
          rawGateway.any((dynamic p) => p is! String || !p.startsWith('/') || p.isEmpty)) {
        throw BundleException(
            'bundle.json "backend.gateway" must be a list of "/"-prefixed strings');
      }
      final List<String> parsed =
          List<String>.from(rawGateway.cast<String>());
      // Absent or empty gateway falls back to the established "/" convention.
      if (parsed.isNotEmpty) gateway = parsed;
    }
    final Object? rawAi = raw['ai'];
    final bool ai = rawAi is bool ? rawAi : false;
    // 声明即接入:backend.tools 段(可选)。坏声明直接拒装(与 start/health
    // 同口径的严格校验);老 server 按未知字段忽略整个段(R1 演进规则)。
    final Object? rawTools = raw['tools'];
    if (rawTools != null) {
      final String? problem = validateToolsManifest(rawTools);
      if (problem != null) {
        throw BundleException('bundle.json "backend.tools": $problem');
      }
    }
    return BundleBackend(
      start: start.trim(),
      health: health,
      gateway: gateway,
      ai: ai,
      tools: rawTools,
    );
  }
}

/// The zip's regular-file entry at exactly [name], or null.
ArchiveFile? bundleEntry(Archive archive, String name) {
  for (final ArchiveFile file in archive.files) {
    if (file.name == name && file.isFile) return file;
  }
  return null;
}

/// Zip entry names are app-authored: reject anything that could escape the
/// extraction root before it reaches the filesystem. Directory entries carry
/// a trailing slash — allowed there, nowhere else.
bool isSafeZipEntryName(String name) {
  if (name.isEmpty || name.startsWith('/') || name.contains(r'\')) return false;
  final bool isDir = name.endsWith('/');
  final String trimmed = isDir ? name.substring(0, name.length - 1) : name;
  if (trimmed.isEmpty) return false;
  for (final String part in trimmed.split('/')) {
    if (part.isEmpty || part == '.' || part == '..') return false;
  }
  return true;
}

/// Entry-file token of a `backend.start` command: the first argument that
/// names a file inside the package ("node dist/main.js" → "dist/main.js").
/// Runtime tokens ("node", "npm", "python3"), flags ("--harmony", "-A") and
/// bare subcommands ("start") don't name package files and are skipped.
/// Returns null when no argument names an entry file — v1 requires one so
/// the gate can prove the entry ships in the zip (§5①).
String? backendStartEntry(String start) {
  const List<String> entryExtensions = <String>[
    '.js', '.mjs', '.cjs', '.ts', '.py', '.sh',
  ];
  for (final String token in start.split(RegExp(r'\s+'))) {
    if (token.isEmpty || token.startsWith('-')) continue;
    final String normalised =
        token.startsWith('./') ? token.substring(2) : token;
    final bool looksLikePath =
        normalised.contains('/') ||
            entryExtensions.any(normalised.endsWith);
    if (looksLikePath) return normalised;
  }
  return null;
}

/// Outcome of [gateBundle]: either a parsed manifest or an error with the
/// status the endpoint should answer.
class BundleGateResult {
  const BundleGateResult(this.manifest, this.error, {this.statusCode = 400});

  final BundleManifest? manifest;
  final String? error;
  final int statusCode;

  bool get rejected => error != null;
}

/// The install gate (§5①): every check decidable before anything is written.
/// [latestVersionCode] is the market's newest code for this appId, or null on
/// first install — the strictly-increasing rule only applies to upgrades.
BundleGateResult gateBundle(
  Archive archive, {
  required int zipBytes,
  int? latestVersionCode,
}) {
  try {
    return BundleGateResult(
        _gate(archive, zipBytes: zipBytes, latestVersionCode: latestVersionCode),
        null);
  } on BundleException catch (error) {
    return BundleGateResult(null, error.message, statusCode: error.statusCode);
  }
}

BundleManifest _gate(
  Archive archive, {
  required int zipBytes,
  required int? latestVersionCode,
}) {
  if (zipBytes > maxBundleBytes) {
    throw BundleException(
        'bundle is $zipBytes bytes; the limit is $maxBundleBytes (10 MiB)');
  }

  // --- bundle.json: required, parseable, consumable ---
  final ArchiveFile? manifestEntry = bundleEntry(archive, 'bundle.json');
  if (manifestEntry == null) {
    throw BundleException(
        'bundle.json missing at zip root — old-format packages are rejected');
  }
  Object? decoded;
  try {
    decoded = jsonDecode(
        utf8.decode(Uint8List.fromList(manifestEntry.content as List<int>),
            allowMalformed: true));
  } catch (_) {
    throw BundleException('bundle.json is not valid JSON');
  }
  final BundleManifest manifest = BundleManifest.parse(decoded);

  // --- frontend slice present (same minimum the plain publish gate uses) ---
  if (bundleEntry(archive, 'main/app-config.json') == null ||
      bundleEntry(archive, 'main/logic.js') == null) {
    throw BundleException(
        'bundle must contain main/app-config.json and main/logic.js');
  }

  // --- path safety + native-extension rejection, over every entry ---
  int unpackedBytes = 0;
  for (final ArchiveFile entry in archive.files) {
    if (!isSafeZipEntryName(entry.name)) {
      throw BundleException('unsafe zip entry path "${entry.name}"');
    }
    if (entry.isFile) {
      if (entry.name.endsWith('.node')) {
        throw BundleException(
            'native extensions (.node) are rejected: ${entry.name}');
      }
      unpackedBytes += entry.size;
    }
  }
  if (unpackedBytes > maxUnpackedBytes) {
    throw BundleException(
        'unpacked content is $unpackedBytes bytes; the limit is '
        '$maxUnpackedBytes (64 MiB)');
  }

  // --- appId consistency: project.config.json (when shipped) must agree ---
  final ArchiveFile? projectConfig = bundleEntry(archive, 'project.config.json');
  if (projectConfig != null) {
    try {
      final Object? config = jsonDecode(utf8.decode(
          Uint8List.fromList(projectConfig.content as List<int>),
          allowMalformed: true));
      final String appid =
          config is Map<String, Object?> ? config['appid'] as String? ?? '' : '';
      if (appid != manifest.appId) {
        throw BundleException(
            'project.config.json appid "$appid" does not match bundle.json '
            'appId "${manifest.appId}"');
      }
    } on BundleException {
      rethrow;
    } catch (_) {
      throw BundleException('project.config.json is not valid JSON');
    }
  }

  // --- versionCode strictly increases (upgrades only, §5①) ---
  if (latestVersionCode != null && manifest.versionCode <= latestVersionCode) {
    throw BundleException(
        'version.code must be > $latestVersionCode (strictly increasing on upgrade)',
        statusCode: 409);
  }

  // --- backend.start entry file must ship in the zip (§5①) ---
  final BundleBackend? backend = manifest.backend;
  if (backend != null) {
    final String? entryFile = backendStartEntry(backend.start);
    if (entryFile == null) {
      throw BundleException(
          'backend.start "${backend.start}" names no entry file — v1 requires a '
          'command whose entry file ships inside backend/ (e.g. "node dist/main.js")');
    }
    if (bundleEntry(archive, 'backend/$entryFile') == null) {
      throw BundleException(
          'backend.start entry file "backend/$entryFile" is not in the package');
    }
  }

  return manifest;
}
