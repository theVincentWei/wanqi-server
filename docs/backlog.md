# Backlog(2026-11-11 夜间收口时登记)

## 契约比对观察项(task-5 复核,不阻塞)
1. `refresh`(无 since)只回最新 50 条,消费方注释自称「拉全量历史」——历史超 50 条时通知中心看不到更早条目。未来:消费方分页游标,或 server 对无 since 请求放宽上限。
2. `_read`(已读)无鉴权,与 `_poll`(deviceToken)不对称——建议下轮一行对齐(`_read` 同走 `_deviceAuthorized`)。
3. 未来启用 deviceToken 时:`GET /notices` 对非 loopback 要求 Bearer,而 dsh-go 消费方无 header——需同步给 apphub_notices.dart/state 加 header(当前两处 config deviceToken 均空,不触发)。

## 版本路线(源自 Bundle 规范 §7)
- v1.1:DB migrations(累积式+幂等白名单)· 后端状态枚举实时回写 · 蓝绿升级 · unpublish/--purge · 并发锁 · journal 对账
- v1.2:分片分发 · 可复现打包+bundleSha256 · minContainer 强制执行 · tools/capabilities 门禁 · export/import-data
- v2:多机交换 · 数据源路由表/多连 · R1–R4 完整演进 · 多运行时
- 多机手机侧:阶段一离线地基(见 review/design-multi-host.md)· 阶段二三态状态机
