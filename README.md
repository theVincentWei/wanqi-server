# 万器(wanqi)

**小程序管理框架**:Bundle 装/升/回滚/卸四命令 + 市场 + 网关 + 通知,单用户自用、可整体开源。装一个 Bundle,前后端全通,零手工。

- 前端 = 手机容器里的小程序(Dimina,微信小程序语法),跑 DMCC 编译产物;
- 后端 = 主机上的服务进程(Node),由 server 托管:动态端口、健康探测、崩溃看护、网关路由全自动;
- 一个 Bundle 一个 zip、一个版本号,装 / 升 / 回滚 / 卸载四条命令走天下。

## 四仓拓扑(2026-11-11 定稿)

| 仓 | 角色 | 与本仓的关系 |
|---|---|---|
| **wanqi**(本仓) | 小程序管理框架:server + `wanqi` CLI + Bundle 规范/手册 + 工作流 skill | —— |
| **dsh-go-miniprograms** | 小程序源码仓:12 个示例的源码真身 + `dist/` 发布 zip | 快速开始与验收从这里取包 |
| **dsh-Go** | 手机宿主(fork,单仓) | 经市场 API 装/升;本地提交分类目录在其仓内 `local-series/` |
| **dimina** | 容器 fork(didi/dimina,单仓) | 本地适配补丁存档在其仓内 `patches/` |

开发位置、升级与归档节奏见 [docs/workflow.md](docs/workflow.md)。

## Bundle 是什么

```
<appId>-<versionCode>.zip
├── bundle.json        # 应用清单(必选;缺 → 拒收)
├── main/              # 前端:DMCC 编译产物(必选)
└── backend/           # 后端(可选):产物 + 依赖随包(node_modules)
```

`bundle.json` 声明身份(`appId`)、版本(`version.code` 严格递增)、启动页(`frontend.entry`)与后端形态(`backend.start/health/gateway`)。字段语义详见 [docs/pack-and-install.md](docs/pack-and-install.md),格式规范详见 [docs/design-bundle-spec.md](docs/design-bundle-spec.md)。

## 30 秒快速开始

```bash
git clone <this-repo> && cd wanqi
git clone <miniprograms-repo>          # dsh-go-miniprograms,与 wanqi 并列放置

# 0. 先体检(不健康会自动按依赖序拉起;装了全局命令则直接 `wanqi service doctor`)
dart run bin/wanqi.dart service doctor

# 1. 起服务端(默认 :7610;测试建议 :7620)
cd server && dart pub get
dart run bin/apphub.dart

# 2. 装一个示例 Bundle(小程序仓 dist/ 自带 12 个)
dart run bin/wanqi.dart bundle install ../../dsh-go-miniprograms/dist/wx5b8e2f4a9c1d7e60-10.zip

# 3. 打开市场 / 拉应用列表
curl -s http://127.0.0.1:7620/api/v1/apps | head
```

装全局命令(可选;之后任何目录直接 `wanqi service doctor` / `wanqi bundle install …`):

```bash
cp server/tool/wanqi ~/.local/bin/wanqi && chmod +x ~/.local/bin/wanqi
```

带后端的示例(sys-monitor)会自动:解包 `backend/` → 动态端口拉起 → 打 `/healthz` 到 200 → 按网关前缀注册路由;server 重启后自动重拉。四命令(均不碰 `data/logs/DB`):

```bash
wanqi bundle install <zip>     # 装
wanqi bundle upgrade <zip>     # 升(失败自动退回上一版)
wanqi bundle rollback <appId>  # 回滚到 previous
wanqi bundle remove <appId>    # 卸(data/logs/DB 保留,重装即恢复;--purge 才清数据)
```

## 目录结构

```
wanqi/
├── server/             # Dart shelf 服务端(自 dsh-Go/apphub 移植)
│   ├── bin/            # apphub.dart(server)· wanqi.dart(Bundle CLI)
│   ├── lib/            # market/gateway/ai_gateway/store/obs …
│   ├── third_party/    # vendor 依赖(dsh_client)
│   └── tool/           # 配置示例(apphub.config.example.json)
├── docs/               # 打包安装手册 · Bundle 规范 v1 · 通知契约镜像 · 多仓工作流
├── skills/dsh-go-miniprogram  # 开发工作流 skill(复制到 ~/.dsh/skills/ 即装)
└── scripts/            # verify-migration.sh(逐包 install 端到端验收)
```

示例小程序(源码 + 发布 zip)在 **dsh-go-miniprograms 仓**:flappy-bird / glm-quota / three-bench / webbench-3d-webview / weui / shuangpin-coach / star-drift / darkmode-demo / sys-monitor(带后端) / ledger / road-hop / audio-test。appId / 版本对照与 backend 细节见 [docs/pack-and-install.md §6](docs/pack-and-install.md)。

## 通知系统(订阅 → 轮询 → 本地通知)

小程序通知走微信兼容路线:**小程序前端只申请订阅,服务端才有发送权**,通知统一收集到宿主通知中心:

```
小程序 JS ──wx.requestSubscribeMessage──▶ 容器 API 面 ──宿主订阅面板──▶ 用户 accept/reject
     │ (一次性配额 +1 记账)                        ▲ 容器侧补丁见 dimina 仓 patches/notify-only/
     ▼
小程序后端 ──POST /notify(微信同形请求体)──▶ 万器 server(九步发送判定/配额/限流/去重)
                                                  │
手机端轮询 GET /notices ◀──通知中心(未读/已读/点击跳回小程序页)──┘
```

- **发送协议与微信 `subscribe/send` 同形**:`template_id`/`page`/`data` 生效,`touser`/`lang` 空转兼容,
  `errcode` 沿用微信值(40001/40002/40003/43101/45009/47003)——迁入代码按 `errcode` 分支即可。
- **v1 无服务端推送**:手机端拉取(`GET /notices`)+ 本地通知投递;服务端按契约预留
  `PushDispatcher` 抽象与 config `push` 段,未来接 APNs/安卓厂商通道时平台侧接入、小程序代码零改动。
- 容器(Dimina)侧所需改动已物化为补丁,存 **dimina 仓 `patches/notify-only/`**;宿主(手机壳)侧闭源,对接说明同目录 README。

完整契约(三层分工、字段三态表 ✅/🔇/↔、九步发送判定、错误码、实现偏差登记):
[docs/notify-contract.md](docs/notify-contract.md)。

## 把本平台装进你的 DSH

本仓库附带开发工作流 skill:复制到你的 DSH 技能目录即装——

```bash
cp -r skills/dsh-go-miniprogram ~/.dsh/skills/
```

装上后,对 DSH 说「写一个小程序上架市场」「改某个小程序再发一版」「调试小程序容器」时,它会自动加载
万器的小程序全流程(源码 + bundle.json → dmcc 编译 → zip 打包 → `wanqi bundle install` 四命令 →
真机调试),包括深色适配、3D 选型、音频坑、带后端 Bundle 等实战经验。`wanqi` CLI 与 server 在本仓库
`server/`,先 `cd server && dart pub get` 再按 README「30 秒快速开始」起服务;小程序源码与发布 zip
在 dsh-go-miniprograms 仓。

## 文档

- **打包与安装手册(作者视角)**:[docs/pack-and-install.md](docs/pack-and-install.md)
- **Bundle 规范 v1(定稿)**:[docs/design-bundle-spec.md](docs/design-bundle-spec.md)
- **通知系统契约 v1(镜像)**:[docs/notify-contract.md](docs/notify-contract.md) · 容器侧补丁:dimina 仓 `patches/notify-only/`
- **多仓开发与合入策略(四仓)**:[docs/workflow.md](docs/workflow.md)
- 迁移端到端验证:`scripts/verify-migration.sh`(对测试 server 逐包 install + 断言)

## 状态

Bundle v1(最小实现):清单门禁 + `bundle install/upgrade/rollback/remove` + 路由自动注册 + 后端置备托管。2026-11-11 起收敛为四仓拓扑,本仓只携带管理框架本体。演进路线(DB migrations、分片分发、多机交换等)见规范 §7。
