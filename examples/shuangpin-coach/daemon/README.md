# 双拼教练 · 听音数据面 daemon（M3）

node 零依赖静态服务，为小程序「听音打字」模式提供音频与清单。

## 端点（端口 9215，只绑 127.0.0.1）

| 路径 | 返回 |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /manifest.json` | 音频清单 JSON（= 项目 utils/audio.js 的数据体） |
| `GET /audio/c/<cp16>.mp3` | 单字音频，`audio/mpeg`，`Cache-Control: max-age=31536000, immutable` |
| `GET /audio/ex/<cp16>.mp3` | 例词音频，同上 |

`cp16` = 字的 Unicode codepoint 十六进制小写（如 逃 = `9003`）。audio 路径硬校验
`^audio/(c|ex)/[0-9a-f]+\.mp3$`，其余一律 404（防路径穿越）。手机侧统一走
AppHub 网关：`http://127.0.0.1:7610/api/v1/apps/wx3d8b6f2a9c4e7d15/...`。

## 部署目录（生产）

`~/dsh/apphub/backends/wx3d8b6f2a9c4e7d15/`

```
server.js       # 本目录 daemon/server.js 的副本
manifest.json   # 音频清单（gen-audio.py 产物）
audio/c/*.mp3   # 单字音频
audio/ex/*.mp3  # 例词音频（多音字，播例词消歧）
logs/           # launchd StandardOut/Err
```

launchd：label `app.dsh.apphub.shuangpin-coach`，plist 在 `~/Library/LaunchAgents/`，
KeepAlive + RunAtLoad，node 用 `/Users/weimingchen/.local/bin/node`（与 sys-monitor
daemon 同款模式）。

## 手动跑（调试）

```bash
node daemon/server.js                      # 项目源码处
curl -s http://127.0.0.1:9215/health
curl -s http://127.0.0.1:9215/manifest.json | head -c 200
curl -sI http://127.0.0.1:9215/audio/c/9003.mp3
```

## 部署一键脚本

音频生成与部署两步合在 `shuangpin-coach/tools/deploy-m3.sh`（含 launchd、网关
route add、验收 curl 三连），由有 `~/dsh`、`~/Library/LaunchAgents`、`~/Code`
写权限的一方执行（详见 tools/README.md「两步走」说明）。
