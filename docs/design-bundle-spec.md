# Bundle 规范 v1(最小实现,定稿)

> 2026-11-11 定稿。**后续一切按 v1 走**:先跑起来,不做过度设计;演进项全部列在 §7,按需往上加。北极星不变:装一个 Bundle,前后端全通,零手工。

## 1. Bundle 是什么

- **Bundle** = 一个 zip = 前端 `main/`(必选)+ 后端 `backend/`(可选)+ `bundle.json`(必选,应用清单)+ `store.json`(可选,市场文案,链路已有)。
- 前端跑手机容器(Dimina);后端跑主机、AppHub server 托管。
- **一个 Bundle 一个版本号,不分前后端**(它们是同一应用的两半,同仓同作者同节奏)。
- 前端 = 手机容器里的小程序;后端 = 主机上的服务进程,网关是它唯一对外口。无 backend 段 = 纯前端应用。

## 2. 布局

```
sys-monitor.bundle.zip
├── bundle.json        # 应用清单(必选;缺 → 拒收)
├── store.json         # 市场文案(可选)
├── main/              # 前端:DMCC 产物(必选)
└── backend/           # 后端(可选):源码或产物 + node_modules(依赖随包)
```

## 3. bundle.json

```json
{
  "spec": 1,
  "appId": "wx8d31a5f0c94b27e6",
  "name": "系统监视器",
  "version": { "code": 12, "name": "1.0.12" },
  "frontend": { "entry": "pages/index/index" },
  "backend": {
    "start": "node dist/main.js",
    "health": "/healthz",
    "gateway": ["/"],
    "ai": false
  }
}
```

| 字段 | 语义 |
|---|---|
| `spec` | 格式版本。**演进规则就一条:消费方忽略未知字段;`spec` 高于自己支持的 → 拒装** |
| `appId` | 永久身份,不可变;与前端产物一致性强制校验 |
| `name` | 展示名 |
| `version.code / name` | Bundle 版本:严格递增整数(判升级)/ 人看。市场行、详情页、角标、releases 目录全用它 |
| `frontend.entry` | 启动页(manifest `path` 唯一来源) |
| `backend.start` | 启动命令,cwd = 解包后 `backend/`;门禁校验入口文件在包内 |
| `backend.health` | 健康路径,spawn 后打它,200 才算装好 |
| `backend.gateway` | 网关前缀(现状惯例 `"/"`);install 时**自动注册路由**,替代手动 `route add` |
| `backend.ai` | 是否接入 AI 网关(可选) |

## 4. 固定约定(写死,不进清单)

- **依赖随包**(`backend/node_modules`),安装期不联网装依赖;原生扩展(`.node`)拒收。
- **密钥永不进包**;凭据运行时注入。
- **数据与日志**:`backends/<appId>/data` 与 `backends/<appId>/logs`,与代码目录**平级**——升级、回滚、卸载都不动它们;GC 只删代码目录。
- **端口动态分配**(server 挑一个空闲口),经 `APPHUB_PORT` 注入;清单里没有端口字段,后端永远不写死端口,只绑 `127.0.0.1`。
- **环境变量三件套**:`APPHUB_PORT` / `APPHUB_APP_ID` / `APPHUB_DB_URL`。
- **数据库**:装后端时自动建 `app_<appId>` schema + 专属账号(沿用现 publish 的 best-effort 逻辑)。

## 5. 安装:`apphubctl bundle install <zip>`

```
① 校验   main/+bundle.json 存在 · appId 一致 · versionCode 递增(仅升级时)· start 入口文件在包内
② 登记   前端进市场(现链路不动)
③ 解包   backend/ → backends/<appId>/,上一版留作 previous/
④ 拉起   动态端口 → spawn(server 子进程,环境注入)→ health 200;失败报错、保留旧版
⑤ 注册   gateway 前缀 → routes 表(自动);市场行 backend: true
⑥ 常驻   server 重启/主机重启后:把所有「已装且有 backend」的 app 重新 spawn(崩溃退避重启)
```

## 6. 升级 / 回滚 / 卸载

| 动作 | 行为 |
|---|---|
| `bundle upgrade` | 停旧 → 换目录(旧版留作 previous/)→ 起新 → health → 更新路由;**失败自动退回 previous/** |
| `bundle rollback` | current 指回 previous → 重启 → 重注册路由 |
| `bundle remove` | 停进程 + 反注册路由;**data/logs/DB 保留**(重装即恢复;不做 --purge) |

单用户自用:不做锁、不做 journal、不做 unpublish——遇到再说。

## 7. 明确不做(v1 范围外 = 后续版本路线)

| 版本 | 加什么 |
|---|---|
| **v1.1** | DB migrations 机制(累积式+幂等白名单)· 后端状态枚举实时回写(现在只有 running/stopped)· 蓝绿升级(现在停机几秒)· unpublish / --purge · 并发锁 · server 启动 journal 对账 |
| **v1.2** | 分片分发(app/backend 双 zip,手机不背 node_modules)· 可复现打包 + bundleSha256 · minContainer 强制执行 · tools.json 收编 + capabilities 门禁 · export/import-data |
| **v2** | 多机交换(同一 Bundle 装到所有主机)· 数据源路由表 / 小程序多连 · 完整 R1–R4 演进规则 · 多运行时(python/go) |

注:多机阶段一(手机侧离线地基,见 `design-multi-host.md`)不依赖 Bundle v1,可并行先行。

## 8. 实施分期(共 ≈3 天)

1. **第 1 步(≈1 天)**:`bundle.json` 门禁 + `bundle install/upgrade/rollback/remove` 命令 + 路由自动注册 + 现有 12 包补清单重发(顺带清掉双拼死路由等脏数据)。
2. **第 2 步(≈2 天)**:置备托管(spawn 看护 + health + DB + server 启动重启),sys-monitor 迁入实测,拆掉手写 launchd plist。

手机侧零改动(manifest 安装链路照旧)。
