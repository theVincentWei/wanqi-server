/// Market data access over [Db]: apps, versions, routes, events, and the
/// per-app MariaDB provisioning (schema `app_<appId>` + dedicated user).
/// mysql1's assoc() hands back strings, so every integer column is normalised
/// here — callers see plain ints/strings.
library;

import 'dart:convert' show jsonDecode;

import 'db.dart';

/// Same character set as dsh-go's applet ids: lowercase letters, digits and
/// hyphens; this doubles as the MariaDB schema suffix, so stay strict here.
bool isValidAppId(String id) => RegExp(r'^[a-z0-9][a-z0-9-]{0,62}$').hasMatch(id);

int? _int(Object? value) =>
    value == null ? null : value is int ? value : int.tryParse(value.toString());

/// TIMESTAMP values reach [Db.q] as [DateTime] and leave it as ISO-8601
/// strings — accept both shapes so callers always get a string or null.
String? _iso(Object? value) {
  if (value is DateTime) return value.toIso8601String();
  if (value is String && value.isNotEmpty) return value;
  return null;
}

/// The listing's one-line subtitle for list rows — absent or malformed
/// stored JSON degrades to '' so the market list never breaks on a bad
/// store.json.
String _subtitleFrom(Object? listingJson) {
  if (listingJson is! String || listingJson.isEmpty) return '';
  try {
    final Object? listing = jsonDecode(listingJson);
    final Object? subtitle =
        listing is Map<String, Object?> ? listing['subtitle'] : null;
    return subtitle is String ? subtitle : '';
  } catch (_) {
    return '';
  }
}

class Store {
  Store(this.db);

  final Db db;

  /// [backend] tri-state: null = leave the stored flag alone (plain publish),
  /// true/false = bundle install/remove owns it (Bundle v1 §5⑤).
  Future<void> upsertApp(String appId, String name, String path,
      {String? description, String? category, bool? backend, bool? autoSync}) async {
    await db.exec(
        'INSERT INTO apps (app_id, name, path, description, category, backend, auto_sync) VALUES (?, ?, ?, ?, ?, ?, ?) '
        'ON DUPLICATE KEY UPDATE name = VALUES(name), path = VALUES(path), '
        'description = VALUES(description), category = VALUES(category), '
        'backend = COALESCE(VALUES(backend), backend), '
        'auto_sync = COALESCE(VALUES(auto_sync), auto_sync)',
        [
          appId,
          name,
          path,
          description,
          category,
          backend == null ? null : (backend ? 1 : 0),
          autoSync == null ? null : (autoSync ? 1 : 0),
        ]);
  }

  /// Uninstall (Bundle v1 §6 remove): drops the market rows. Package zips,
  /// install events and the per-app DB schema are intentionally kept.
  Future<void> deleteApp(String appId) async {
    await db.exec('DELETE FROM app_versions WHERE app_id = ?', [appId]);
    await db.exec('DELETE FROM apps WHERE app_id = ?', [appId]);
  }

  /// Bundle-level rollback (§6): re-points the market at an older version by
  /// dropping every newer row. The zips stay on disk, so a re-upgrade just
  /// re-inserts them. (The legacy 旧包新版本号 rollback above never
  /// downgrades versionCode — that guard protects Dimina pulls, while bundle
  /// rollback is an operator action that intentionally reverts the code.)
  Future<void> deleteVersionsAbove(String appId, int code) async {
    await db.exec(
        'DELETE FROM app_versions WHERE app_id = ? AND version_code > ?',
        [appId, code]);
  }

  /// Backend flag without touching name/path (legacy-donor rollbacks).
  Future<void> setAppBackend(String appId, bool backend) async {
    await db.exec('UPDATE apps SET backend = ? WHERE app_id = ?',
        [backend ? 1 : 0, appId]);
  }

  Future<void> insertVersion({
    required String appId,
    required int versionCode,
    required String versionName,
    required String zipPath,
    required String sha256,
    required int sizeBytes,
    String? changelog,
    String? icon,
    String? iconFile,
    String? toolsJson,
    String? permissionsJson,
    String? minContainer,
    String? listingJson,
  }) async {
    await db.exec(
        'INSERT INTO app_versions '
        '(app_id, version_code, version_name, zip_path, sha256, size_bytes, changelog, icon, icon_file, tools_json, permissions_json, min_container, listing_json) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [appId, versionCode, versionName, zipPath, sha256, sizeBytes, changelog, icon, iconFile, toolsJson, permissionsJson, minContainer, listingJson]);
  }

  Future<Map<String, Object?>?> latestVersion(String appId) async {
    final List<Map<String, Object?>> rows = await db.q(
        'SELECT * FROM app_versions WHERE app_id = ? ORDER BY version_code DESC LIMIT 1',
        [appId]);
    return rows.isEmpty
        ? null
        : <String, Object?>{
            'app_id': rows.first['app_id'],
            'version_code': _int(rows.first['version_code']),
            'version_name': rows.first['version_name'],
            'zip_path': rows.first['zip_path'],
            'sha256': rows.first['sha256'],
            'size_bytes': _int(rows.first['size_bytes']),
            'changelog': rows.first['changelog'],
            'icon': rows.first['icon'],
            'icon_file': rows.first['icon_file'],
            'tools_json': rows.first['tools_json'],
            'permissions_json': rows.first['permissions_json'],
            'min_container': rows.first['min_container'],
            // listing_json 原样字符串(NULL 表示无 store.json 详情),detail/
            // rollback 各自解析;created_at 保留原始值,market 层负责格式化。
            'listing_json': rows.first['listing_json'],
            'created_at': rows.first['created_at'],
          };
  }

  /// The newest version strictly below [belowVersionCode] — rollback's donor.
  Future<Map<String, Object?>?> versionBelow(String appId, int belowVersionCode) async {
    final List<Map<String, Object?>> rows = await db.q(
        'SELECT * FROM app_versions WHERE app_id = ? AND version_code < ? '
        'ORDER BY version_code DESC LIMIT 1',
        [appId, belowVersionCode]);
    return rows.isEmpty
        ? null
        : <String, Object?>{
            'version_code': _int(rows.first['version_code']),
            'version_name': rows.first['version_name'],
            'zip_path': rows.first['zip_path'],
            'sha256': rows.first['sha256'],
            'size_bytes': _int(rows.first['size_bytes']),
            'changelog': rows.first['changelog'],
            'icon': rows.first['icon'],
            'icon_file': rows.first['icon_file'],
            'tools_json': rows.first['tools_json'],
            'permissions_json': rows.first['permissions_json'],
            'min_container': rows.first['min_container'],
            'listing_json': rows.first['listing_json'],
          };
  }

  Future<List<Map<String, Object?>>> listApps() async {
    final List<Map<String, Object?>> rows = await db.q(
        'SELECT a.app_id, a.name, a.path, a.category, a.backend, a.auto_sync, a.created_at, '
        'v.version_code, v.version_name, v.sha256, v.changelog, v.icon, v.icon_file, '
        // listing_json 只为取列表行的一行副标题,解析失败按空串降级。
        'v.listing_json, v.size_bytes, v.permissions_json '
        'FROM apps a LEFT JOIN app_versions v '
        'ON v.app_id = a.app_id AND v.version_code = '
        '(SELECT MAX(version_code) FROM app_versions WHERE app_id = a.app_id) '
        'ORDER BY a.name');
    return <Map<String, Object?>>[
      for (final row in rows)
        <String, Object?>{
          'appId': row['app_id'],
          'name': row['name'],
          'path': row['path'],
          'category': row['category'],
          'backend': (_int(row['backend']) ?? 0) != 0,
          'autoSync': (_int(row['auto_sync']) ?? 0) != 0,
          'versionCode': _int(row['version_code']),
          'versionName': row['version_name'],
          'sha256': row['sha256'],
          'sizeBytes': _int(row['size_bytes']),
          'changelog': row['changelog'],
          'subtitle': _subtitleFrom(row['listing_json']),
          'icon': row['icon'],
          'iconFile': row['icon_file'],
          // permissions 声明的原始落库 JSON(契约 §2 存储形态);市场层用
          // permissionsForMarket 重塑为透传形态,本字段不出 API。
          'permissionsJson': row['permissions_json'],
        },
    ];
  }

  /// The most recent [limit] versions, newest first — the store detail
  /// page's version history.
  Future<List<Map<String, Object?>>> versions(String appId,
      {int limit = 10}) async {
    final List<Map<String, Object?>> rows = await db.q(
        'SELECT version_code, version_name, changelog, size_bytes, created_at '
        'FROM app_versions WHERE app_id = ? ORDER BY version_code DESC LIMIT ?',
        [appId, limit]);
    return <Map<String, Object?>>[
      for (final row in rows)
        <String, Object?>{
          'versionCode': _int(row['version_code']),
          'versionName': row['version_name'],
          'changelog': row['changelog'],
          'sizeBytes': _int(row['size_bytes']),
          'createdAt': _iso(row['created_at']),
        },
    ];
  }

  Future<void> setLatestTools(String appId, String toolsJson) async {
    await db.exec(
        'UPDATE app_versions SET tools_json = ? '
        'WHERE app_id = ? AND version_code = '
        '(SELECT version_code FROM (SELECT MAX(version_code) AS version_code '
        'FROM app_versions WHERE app_id = ?) t)',
        [toolsJson, appId, appId]);
  }

  Future<void> addEvent(String appId, String event, String? detail) async {
    await db.exec(
        'INSERT INTO install_events (app_id, event, detail) VALUES (?, ?, ?)',
        [appId, event, detail]);
  }

  Future<void> upsertRoute(String appId, String prefix, String target,
      int timeoutMs, int rpm) async {
    await db.exec(
        'INSERT INTO app_routes (app_id, prefix, target, timeout_ms, rpm) '
        'VALUES (?, ?, ?, ?, ?) '
        'ON DUPLICATE KEY UPDATE target = VALUES(target), '
        'timeout_ms = VALUES(timeout_ms), rpm = VALUES(rpm)',
        [appId, prefix, target, timeoutMs, rpm]);
  }

  Future<void> deleteRoute(String appId, String prefix) async {
    await db.exec('DELETE FROM app_routes WHERE app_id = ? AND prefix = ?',
        [appId, prefix]);
  }

  /// Every route of one app — bundle install/remove own the full set (the
  /// table state after install is exactly bundle.json's gateway list).
  Future<void> deleteRoutesForApp(String appId) async {
    await db.exec('DELETE FROM app_routes WHERE app_id = ?', [appId]);
  }

  Future<List<Map<String, Object?>>> listRoutes() async {
    final List<Map<String, Object?>> rows =
        await db.q('SELECT * FROM app_routes ORDER BY app_id, prefix');
    return <Map<String, Object?>>[
      for (final row in rows)
        <String, Object?>{
          'appId': row['app_id'],
          'prefix': row['prefix'],
          'target': row['target'],
          'timeoutMs': _int(row['timeout_ms']),
          'rpm': _int(row['rpm']),
        },
    ];
  }

  /// Best-effort per-app database: schema `app_<appId>` owned by a dedicated
  /// user. Requires the AppHub DB user to hold CREATE/DROP grants (localhost
  /// setup grants ALL). Failures are non-fatal — backends may also bring
  /// their own database.
  Future<String?> provisionAppDb(String appId, String password) async {
    try {
      final String schema = 'app_$appId';
      final String user = 'app_$appId';
      await db.exec('CREATE DATABASE IF NOT EXISTS `$schema` CHARACTER SET utf8mb4');
      await db.exec(
          'CREATE USER IF NOT EXISTS `$user`@`localhost` IDENTIFIED BY ?', [password]);
      await db.exec('ALTER USER `$user`@`localhost` IDENTIFIED BY ?', [password]);
      await db.exec('GRANT ALL PRIVILEGES ON `$schema`.* TO `$user`@`localhost`');
      return schema;
    } catch (_) {
      return null;
    }
  }

  /// --purge(手机端卸载接整包语义,2026-11-11):DROP schema + 删账号。
  /// 全程 best-effort——schema 不存在/无权限时静默跳过(purge 是尽力清空,
  /// 不让残留阻断卸载主流程)。返回是否执行了 DROP。
  Future<bool> dropAppDb(String appId) async {
    final String schema = 'app_$appId';
    final String user = 'app_$appId';
    try {
      await db.exec('DROP DATABASE IF EXISTS `$schema`');
      try {
        await db.exec('DROP USER IF EXISTS `$user`@`localhost`');
      } catch (_) {
        // 账号可能从未发放过(纯前端 app 也会走 provision,但老库未必)。
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /// --purge:清该 app 的 app_tokens 行(发放过的发送凭据一并作废)。
  Future<void> purgeAppTokens(String appId) async {
    await db.exec('DELETE FROM app_tokens WHERE app_id = ?', [appId]);
  }

  /// --purge:清该 app 的通知行(模板/订阅配额/通知对象/应用级开关)。
  /// global 开关与 install_events 历史保留(闭集定义,purge 不出此范围)。
  Future<void> purgeNotifyRows(String appId) async {
    await db.exec('DELETE FROM notify_templates WHERE app_id = ?', [appId]);
    await db.exec('DELETE FROM notify_subscriptions WHERE app_id = ?', [appId]);
    await db.exec('DELETE FROM notify_messages WHERE app_id = ?', [appId]);
    await db.exec("DELETE FROM notify_prefs WHERE scope = ?", ['app:$appId']);
  }
}
