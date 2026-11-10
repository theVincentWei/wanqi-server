/// routes 清理脚本(Bundle v1 第 1 步):清空 app_routes 表——旧格式手工
/// `route add` 的脏路由(双拼 :9215、WeUI /v1→:9、音频验收/webbench 死
/// target)随之一并消失。此后 routes 表由 `bundle install` 按 bundle.json 的
/// gateway 声明自动重建,不再手工维护。
///
/// 用法:
///   dart run tool/reset_routes.dart --config config.local.json --yes
/// 不带 --yes 只预览(打印将删除的行数)。
///
/// 注意:server 进程只在启动/注册路由时 reload 网关——对运行中的生产
/// server(:7610)直接清表不会即时改变其内存路由,需等其重启或由 lead 走
/// 正式通道;本脚本默认只对测试环境执行。
library;

import 'dart:io';

import 'package:args/args.dart';
import 'package:mysql1/mysql1.dart'
    show ConnectionSettings, MySqlConnection, ResultRow;

import 'package:apphub/config.dart';

Future<void> main(List<String> args) async {
  final parser = ArgParser()
    ..addOption('config', defaultsTo: 'config.local.json')
    ..addFlag('yes', abbr: 'y', defaultsTo: false);
  final ArgResults parsed;
  try {
    parsed = parser.parse(args);
  } on ArgParserException catch (error) {
    stderr.writeln(error.message);
    stderr.writeln('usage: dart run tool/reset_routes.dart --config <path> [--yes]');
    exitCode = 64;
    return;
  }

  final AppConfig cfg = await AppConfig.load(parsed['config'] as String);
  final MySqlConnection conn = await MySqlConnection.connect(ConnectionSettings(
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    db: cfg.db.database,
  ));
  try {
    final List<ResultRow> rows = await conn
        .query('SELECT app_id, prefix, target FROM app_routes ORDER BY app_id, prefix');
    stdout.writeln('db ${cfg.db.database} @ ${cfg.db.host}:${cfg.db.port}');
    for (final ResultRow row in rows) {
      stdout.writeln(
          '  route ${row['app_id']} ${row['prefix']} -> ${row['target']}');
    }
    final int n = rows.length;
    stdout.writeln('routes to delete: $n');
    if (!(parsed['yes'] as bool)) {
      stdout.writeln('dry run — rerun with --yes to delete');
      return;
    }
    await conn.query('DELETE FROM app_routes');
    final List<ResultRow> remaining =
        await conn.query('SELECT app_id FROM app_routes');
    stdout.writeln('cleared; remaining: ${remaining.length}');
    stdout.writeln('hint: bundle apps re-register via `wanqi bundle install`');
  } finally {
    await conn.close();
  }
}
