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

// ---------------------------------------------------------------------------
// permissions 声明段(平台权限契约 v1.0 §1/§2,2026-11-14 冻结)
//
// 单一来源:[bundleScopeCatalog] 同时是 bundle.json 门禁的 scope 白名单和
// 市场透传的 title/mode 出处——scope 串与分级字面量在两处永不漂移。
// ---------------------------------------------------------------------------

/// One frozen catalog row (契约 §1): the market-facing Chinese display name
/// plus the contract's authorisation level. Levels, verbatim: 授权级 =
/// first-use native dialog persisted per appId; 声明级 = usable once
/// declared, no dialog; 占位级 = catalogued but the v1 container honestly
/// fails the calls — declaring is still legal, enforcement is the
/// container's job, this layer only validates the declaration itself.
class BundleScopeSpec {
  const BundleScopeSpec({required this.title, required this.mode});

  final String title;
  final String mode;
}

/// The frozen scope directory (契约 §1). network.external is deliberately
/// absent — external domains are declared under `permissions.network`
/// and travel the wire as `network.domains`, never as a scope key.
const Map<String, BundleScopeSpec> bundleScopeCatalog =
    <String, BundleScopeSpec>{
  'scope.record': BundleScopeSpec(title: '麦克风/录音', mode: '授权级'),
  'scope.notification': BundleScopeSpec(title: '本地通知/订阅消息', mode: '授权级'),
  'scope.contacts': BundleScopeSpec(title: '通讯录', mode: '声明级'),
  'scope.camera': BundleScopeSpec(title: '相机', mode: '占位级'),
  'scope.writePhotosAlbum': BundleScopeSpec(title: '保存到相册', mode: '占位级'),
  'scope.bluetooth': BundleScopeSpec(title: '蓝牙', mode: '占位级'),
  'scope.clipboard': BundleScopeSpec(title: '剪贴板', mode: '占位级'),
  'scope.userLocation': BundleScopeSpec(title: '位置信息', mode: '占位级'),
};

/// One entry of bundle.json `permissions.scopes` (契约 §2). [desc] is the
/// consent-dialog copy (弹窗文案) and is mandatory.
class BundlePermissionScope {
  const BundlePermissionScope({required this.scope, required this.desc});

  final String scope;
  final String desc;

  Map<String, Object?> toJson() =>
      <String, Object?>{'scope': scope, 'desc': desc};
}

/// The optional `permissions` section of bundle.json (契约 §2). Null on the
/// manifest = the app declares nothing sensitive — the 12 display-only apps
/// install untouched (缺段=合法).
class BundlePermissions {
  const BundlePermissions({required this.scopes, required this.domains});

  final List<BundlePermissionScope> scopes;

  /// http(s) origins the app may reach beyond the box; empty = 本机网关 only
  /// (契约 §1 network.external 缺省语义).
  final List<String> domains;

  bool get isEmpty => scopes.isEmpty && domains.isEmpty;

  /// The declaration encoded for `app_versions.permissions_json` (同
  /// tools_json 形态), or null when nothing is declared.
  String? get permissionsJson => isEmpty
      ? null
      : jsonEncode(<String, Object?>{
          'scopes': <Object?>[for (final s in scopes) s.toJson()],
          'network': <String, Object?>{'domains': domains},
        });
}

/// Parses and strictly validates the optional `permissions` section (契约 §2,
/// 严式校验照抄 backend.tools 先例:坏声明直接 [BundleException] 拒装;老 server
/// 按未知字段忽略整个段,spec §3 R1 演进规则天然兼容)。Null input = no section.
BundlePermissions? parseBundlePermissions(Object? raw) {
  if (raw == null) return null;
  if (raw is! Map<String, Object?>) {
    throw BundleException('bundle.json "permissions" must be an object');
  }
  final List<BundlePermissionScope> scopes = <BundlePermissionScope>[];
  final Object? rawScopes = raw['scopes'];
  if (rawScopes != null) {
    if (rawScopes is! List) {
      throw BundleException('bundle.json "permissions.scopes" must be a list');
    }
    for (final dynamic entry in rawScopes) {
      if (entry is! Map<String, Object?>) {
        throw BundleException(
            'bundle.json "permissions.scopes": each entry must be an object');
      }
      final Object? scope = entry['scope'];
      if (scope is! String || !bundleScopeCatalog.containsKey(scope)) {
        throw BundleException(
            'bundle.json "permissions.scopes": unknown scope "$scope" — must be '
            'one of the frozen catalog (${bundleScopeCatalog.keys.join(', ')})');
      }
      final Object? desc = entry['desc'];
      if (desc is! String || desc.trim().isEmpty) {
        throw BundleException(
            'bundle.json "permissions.scopes": scope "$scope" needs a non-empty '
            '"desc" (弹窗文案)');
      }
      scopes.add(BundlePermissionScope(scope: scope, desc: desc.trim()));
    }
  }
  final List<String> domains = <String>[];
  final Object? rawNetwork = raw['network'];
  if (rawNetwork != null) {
    if (rawNetwork is! Map<String, Object?>) {
      throw BundleException('bundle.json "permissions.network" must be an object');
    }
    final Object? rawDomains = rawNetwork['domains'];
    if (rawDomains != null) {
      if (rawDomains is! List) {
        throw BundleException(
            'bundle.json "permissions.network.domains" must be a list');
      }
      for (final dynamic domain in rawDomains) {
        if (domain is! String || !isValidExternalDomain(domain)) {
          throw BundleException(
              'bundle.json "permissions.network.domains": "$domain" is not a '
              'valid http(s) URL');
        }
        domains.add(domain);
      }
    }
  }
  return BundlePermissions(scopes: scopes, domains: domains);
}

/// 契约 §2:domains 必须是合法 http(s) URL — scheme http/https + 非空 host。
/// Path 允许(声明的是可达性,匹配语义归容器执法侧,契约 §3)。
bool isValidExternalDomain(String value) {
  final Uri? uri = Uri.tryParse(value);
  if (uri == null) return false;
  if (uri.scheme != 'http' && uri.scheme != 'https') return false;
  return uri.host.isNotEmpty;
}

/// Market transmit shaping (契约 §5): re-renders a stored
/// `permissions_json` into the shape the dsh-go host renders —
/// `{"scopes":[{"key","title","usage","mode"}],"network":{"domains":[…]}}`.
/// title = 中文名 from [bundleScopeCatalog], usage = the app's own desc,
/// mode = 契约 §1 分级. Null / undeclared / corrupt stored JSON → null
/// (callers omit or emit null — both read as 「无声明」 downstream).
Map<String, Object?>? permissionsForMarket(String? permissionsJson) {
  if (permissionsJson == null || permissionsJson.isEmpty) return null;
  Object? decoded;
  try {
    decoded = jsonDecode(permissionsJson);
  } catch (_) {
    return null;
  }
  if (decoded is! Map<String, Object?>) return null;
  final List<Map<String, Object?>> scopes = <Map<String, Object?>>[];
  final Object? rawScopes = decoded['scopes'];
  if (rawScopes is List) {
    final Set<String> seen = <String>{};
    for (final dynamic entry in rawScopes) {
      if (entry is! Map<String, Object?>) continue;
      final Object? key = entry['scope'];
      if (key is! String || !seen.add(key)) continue; // 去重,保留首条
      final BundleScopeSpec? spec = bundleScopeCatalog[key];
      final Object? usage = entry['desc'];
      scopes.add(<String, Object?>{
        'key': key,
        'title': spec?.title ?? key,
        if (usage is String && usage.isNotEmpty) 'usage': usage,
        'mode': spec?.mode ?? '占位级',
      });
    }
  }
  final Object? rawNetwork = decoded['network'];
  final List<String> domains = <String>[
    if (rawNetwork is Map<String, Object?> && rawNetwork['domains'] is List)
      for (final dynamic domain in rawNetwork['domains'] as List)
        if (domain is String && domain.isNotEmpty) domain,
  ];
  if (scopes.isEmpty && domains.isEmpty) return null;
  return <String, Object?>{
    'scopes': scopes,
    'network': <String, Object?>{'domains': domains},
  };
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
    this.permissions,
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

  /// Null = the app declares nothing sensitive (契约 §2:缺段=合法,纯展示
  /// app 零改动零发版)。声明本身在这里被严式校验;能力执法在容器侧。
  final BundlePermissions? permissions;

  /// The permissions declaration encoded for `app_versions.permissions_json`
  /// (同 tools_json 形态), or null when nothing is declared.
  String? get permissionsJson => permissions?.permissionsJson;

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
      // permissions 声明段(契约 §2,可选):严式校验,坏声明直接拒装——
      // 在 parse 层做,gateBundle 走 BundleManifest.parse 即天然覆盖。
      permissions: parseBundlePermissions(decoded['permissions']),
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
