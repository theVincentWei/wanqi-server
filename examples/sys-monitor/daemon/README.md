# sys-monitor daemon(小程序后端)

系统监视器(wx8d31a5f0c94b27e6)的后端:采集本机(Mac)CPU/内存/磁盘/uptime + 进程榜,供小程序轮询。源自 baigong miniapps/sys-monitor daemon,2026-11-09 合入本仓(合入时仅改包名与说明,采集/路由逻辑零改动)。

## 端点(监听 127.0.0.1:9207)

- `GET /stats` — 秒回缓存优先(30s 快档),冷窗现采兜底
- `GET /history` — 5 分钟一笔账本 + summary 现算
- `GET /processes` — Top 20 进程缓存(展示前 10)
- `GET /processes/{pid}` / `POST /processes/{pid}/kill` — 详情/SIGTERM 杀进程(保护名单三保险)
- `GET /healthz` — 生命周期探测

## 本机部署(已装,launchd 看护)

部署位置按 `docs/apps/miniprogram-spec.md` §5 约定:`~/dsh/apphub/backends/wx8d31a5f0c94b27e6/`(源码同步过去 + 装依赖)。
常驻走 launchd:`~/Library/LaunchAgents/app.dsh.apphub.sys-monitor.plist`(KeepAlive + RunAtLoad,日志在部署目录 `logs/`)。

手动操作:

```sh
# 重启
launchctl kickstart -k gui/501/app.dsh.apphub.sys-monitor
# 停用/恢复
launchctl bootout gui/501/app.dsh.apphub.sys-monitor
launchctl bootstrap gui/501 ~/Library/LaunchAgents/app.dsh.apphub.sys-monitor.plist
# 探活
curl -s http://127.0.0.1:9207/healthz
```

## 本地开发

```sh
pnpm install
pnpm start        # tsx src/main.ts,监听 9207
pnpm test         # jest
```

要求 node ≥22.13。真机链路:小程序→设备 127.0.0.1:9207→adb reverse tcp:9207→(214 另需 ssh -R 9207 隧道)→Mac daemon。
