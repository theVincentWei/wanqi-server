# Backlog(2026-11-11 夜间收口时登记)

## 已清理(2026-11-11 早)
- ~~bin/apphubctl.dart 旧 CLI~~ 已删;~~tool/debug_reload.dart 一次性调试脚本~~ 已删;notices.dart 旧注释同步修正。

## 契约比对观察项(task-5 复核,不阻塞)
1. `refresh`(无 since)只回最新 50 条,消费方注释自称「拉全量历史」——历史超 50 条时通知中心看不到更早条目。未来:消费方分页游标,或 server 对无 since 请求放宽上限。
2. `_read`(已读)无鉴权,与 `_poll`(deviceToken)不对称——建议下轮一行对齐(`_read` 同走 `_deviceAuthorized`)。
3. 未来启用 deviceToken 时:`GET /notices` 对非 loopback 要求 Bearer,而 dsh-go 消费方无 header——需同步给 apphub_notices.dart/state 加 header(当前两处 config deviceToken 均空,不触发)。

## 基础设施风险(审计遗留)
- **dsh-go `git push origin main` 执行前,先做全量历史密钥扫描**:push 到公开 fork 会带全部 120 个提交的历史,其中可能混过配置类改动;扫描工具(git log -p + grep 或 gitleaks)过一遍再推。
- dimina fork(shallow 克隆,本地 28 个提交:darkmode 全套/音频 API/redirectTo 双层修复/菜单主题/升级框架/通知/TabBar WIP)~~从未推送任何自己的远端~~ **已于 2026-11-11 补丁化存档**:`patches/dimina/series/`(基线 didi/dimina @eef595c,25 patches + 3 merges,树 SHA 对账无损,git am 干跑全过,无密钥泄漏)。自建私有远端做完整备份仍建议——补丁系列是内容备份,不是可推送的远端。
- dsh-Go 宿主 App(本地 120 提交 = 88 普通 + 32 merge)**已于 2026-11-11 登记分类**:`patches/dsh-go-series/catalog.tsv`(平台对接 55 / 个人 UI 59 / 基础设施 6,一条不落)+ README(基线 a75c6cff、am 不忠实性发现——本仓 merge 携带真实内容,补丁线性重放会丢冲突解决,**正确备份/升级走 git 原生**)。**待用户执行:`git -C ~/Code/dsh-Go push origin main`** 直接备份(origin 是用户自己的 fork);平台类精选补丁物化挂起,等开源范围拍板(从 git 随时可再生)。

## 版本路线(源自 Bundle 规范 §7)
- v1.1:DB migrations(累积式+幂等白名单)· 后端状态枚举实时回写 · 蓝绿升级 · unpublish/--purge · 并发锁 · journal 对账
  - **边界说明(autoSync 静默升级,2026-11-11 task-9,勿当 bug 修)**:autoSync 包
    (`bundle.json "autoSync": true`,作者在发布侧声明)的升级**跳过容器确认弹窗、
    新包就绪即激活**——用户知情权由「发布即确认」替代,这是有意的设计取舍
    (spec §9 / dimina 补丁 0026)。v1.1 做「后端状态枚举实时回写」时,
    autoSync 的升级里程碑(applied/updated)照常经升级事件广播,不要给它加回
    确认弹窗;真要给用户保留否决权,入口是宿主总开关(设置→通用→静默同步),
    不是逐次弹窗。
- v1.2:分片分发 · 可复现打包+bundleSha256 · minContainer 强制执行 · tools/capabilities 门禁 · export/import-data
- v2:多机交换 · 数据源路由表/多连 · R1–R4 完整演进 · 多运行时
- 多机手机侧:阶段一离线地基(见 review/design-multi-host.md)· 阶段二三态状态机
