# Backlog(2026-11-11 夜间收口时登记)

## 已清理(2026-11-11 早)
- ~~bin/apphubctl.dart 旧 CLI~~ 已删;~~tool/debug_reload.dart 一次性调试脚本~~ 已删;notices.dart 旧注释同步修正。

## 契约比对观察项(task-5 复核,不阻塞)
1. `refresh`(无 since)只回最新 50 条,消费方注释自称「拉全量历史」——历史超 50 条时通知中心看不到更早条目。未来:消费方分页游标,或 server 对无 since 请求放宽上限。
2. `_read`(已读)无鉴权,与 `_poll`(deviceToken)不对称——建议下轮一行对齐(`_read` 同走 `_deviceAuthorized`)。
3. 未来启用 deviceToken 时:`GET /notices` 对非 loopback 要求 Bearer,而 dsh-go 消费方无 header——需同步给 apphub_notices.dart/state 加 header(当前两处 config deviceToken 均空,不触发)。

## 基础设施风险(审计遗留)
- dimina fork(shallow 克隆,本地 28 个提交:darkmode 全套/音频 API/redirectTo 双层修复/菜单主题/升级框架/通知/TabBar WIP)~~从未推送任何自己的远端~~ **已于 2026-11-11 补丁化存档**:`patches/dimina-series/`(基线 didi/dimina @eef595c,25 patches + 3 merges,树 SHA 对账无损,git am 干跑全过,无密钥泄漏)。自建私有远端做完整备份仍建议——补丁系列是内容备份,不是可推送的远端。

## 版本路线(源自 Bundle 规范 §7)
- v1.1:DB migrations(累积式+幂等白名单)· 后端状态枚举实时回写 · 蓝绿升级 · unpublish/--purge · 并发锁 · journal 对账
- v1.2:分片分发 · 可复现打包+bundleSha256 · minContainer 强制执行 · tools/capabilities 门禁 · export/import-data
- v2:多机交换 · 数据源路由表/多连 · R1–R4 完整演进 · 多运行时
- 多机手机侧:阶段一离线地基(见 review/design-multi-host.md)· 阶段二三态状态机
