# 万器 Bundle 打包与安装手册

> 面向应用作者:把你手上的小程序(可选加后端)打成 Bundle zip,用 `wanqi` 装进万器 server。
> 规范依据:`design-bundle-spec.md`(Bundle v1,2026-11-11 定稿);本文是它的作者视角落地版。

## 1. 一个 Bundle 是什么

一个 Bundle = 一个 zip = 前后端同一应用的完整交付物,一个版本号:

```
<appId>-<versionCode>.zip
├── bundle.json        # 应用清单(必选;缺 → server 拒收)
├── main/              # 前端:DMCC 编译产物(必选)
└── backend/           # 后端(可选):产物或源码 + node_modules(依赖随包)
```

- `main/` 里的 `store.json`(市场文案)沿用现有链路,随 `main/` 携带即可。
- 无 `backend/` = 纯前端应用,不写 `bundle.json` 的 `backend` 段。
- 一个 Bundle 一个版本号,不分前后端;升级、回滚、路由全按这个版本号走。

## 2. bundle.json 字段说明

```json
{
  "spec": 1,
  "appId": "wx8d31a5f0c94b27e6",
  "name": "系统监视器",
  "version": { "code": 8, "name": "1.3.2" },
  "frontend": { "entry": "pages/index/index" },
  "backend": {
    "start": "node dist/main.js",
    "health": "/healthz",
    "gateway": ["/"],
    "ai": false
  }
}
```

| 字段 | 必选 | 语义 | 作者注意 |
|---|---|---|---|
| `spec` | ✓ | 格式版本,现在恒为 `1` | 消费方忽略未知字段;`spec` 高于其支持的 → 拒装 |
| `appId` | ✓ | 永久身份,不可变 | 必须与源码 `project.config.json` 的 `appid` 一致,install 校验 |
| `name` | ✓ | 展示名 | 市场行标题 |
| `version.code` | ✓ | 严格递增整数,**升级判定唯一依据** | 改任何东西重发都要 +1(重发策略除外,见 §5) |
| `version.name` | ✓ | 人看的版本号 | 市场行、详情页、角标显示它 |
| `frontend.entry` | ✓ | 启动页 | 小程序 = `app.json` `pages[0]`;小游戏 = `"game"`;它是 manifest `path` 的唯一来源 |
| `backend.start` | 有 backend 时 | 启动命令,cwd = 解包后 `backend/` | 入口文件必须在包内(install 校验);**永远不写死端口** |
| `backend.health` | 有 backend 时 | 健康路径 | spawn 后打它,200 才算装好 |
| `backend.gateway` | 有 backend 时 | 网关前缀数组(惯例 `["/"]`) | install 时自动注册路由,不需要手动 `route add` |
| `backend.ai` | 否 | 是否接 AI 网关 | 不接就写 `false` 或省略 |

### 后端运行时约定(写死,不进清单)

- **端口动态分配**:server 挑空闲口,经 `APPHUB_PORT` 环境变量注入;你的后端必须读 `APPHUB_PORT` 决定监听口,且只绑 `127.0.0.1`。
- **环境变量三件套**:`APPHUB_PORT` / `APPHUB_APP_ID` / `APPHUB_DB_URL`(有 DB 时)。
- **依赖随包**:后端依赖放 `backend/node_modules`,安装期不联网装;原生扩展(`.node`)拒收——纯 JS 产物最优。
- **密钥永不进包**:凭据运行时经环境变量注入。
- **数据与日志**:server 放在 `backends/<appId>/data` 与 `logs`,与代码平级;升级/回滚/卸载都不动它们。

## 3. 怎么打包(作者工作流)

### 3.1 纯前端应用(本仓 11 个示例的形态)

1. 写好/改完源码(`~/Code/dsh-go-miniprograms/<pkg>/`)。
2. DMCC 编译出 `main/`(产物:压平的 `*_xxx.js/.css`、`app-config.json`、`logic.js` 等)。
3. 在源码目录放一份 `bundle.json`(本仓每包已放,作为随源码维护的清单)。
4. 组装 zip:

```bash
python3 - <<'EOF'
import json, os, shutil, zipfile
appid, code = json.load(open("bundle.json"))["appId"], json.load(open("bundle.json"))["version"]["code"]
work = "/tmp/bundle-build"; shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
# 把 DMCC 产物解进 work/main/…(此处按你的编译产物布局放置)
shutil.copy("bundle.json", f"{work}/bundle.json")
out = f"dist/{appid}-{code}.zip"; os.makedirs("dist", exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(work):
        for f in sorted(files):
            p = os.path.join(root, f); z.write(p, os.path.relpath(p, work))
EOF
```

### 3.2 带后端的应用(sys-monitor 形态)

在 3.1 基础上,把后端做成 `backend/` 加进 zip。本仓 `sys-monitor` 的做法(可抄):

- 后端源码在 `~/Code/dsh-go-miniprograms/sys-monitor/daemon/`,TypeScript、裸 `node:http`、**零第三方运行时依赖**;
- 预编译:`./node_modules/.bin/tsc -p tsconfig.build.json` → `dist/`(tsconfig.build.json 用 `rewriteRelativeImportExtensions` 把 `.ts` 后缀导入重写为 `.js`,产物零依赖、`node >= 22` 直接跑);
- zip 里放 `backend/dist`(产物)+ `backend/src`(源码)+ `backend/package.json`;因为零运行时依赖,**不需要** node_modules 随包;
- `backend.json` 段:`"start": "node dist/main.js"`、`"health": "/healthz"`、`"gateway": ["/"]`。

### 3.3 从现有发布 zip 快速补 bundle.json(迁移场景)

老包(只有 `main/`)想补成 Bundle,不必重编译——取现有 zip 注入 `bundle.json` 即可。本仓 12 个发布 zip 就是这么来的(`~/Code/dsh-go-miniprograms/dist/`):生产 zip 原样解出 → 注入对应 `bundle.json` → sys-monitor 追加 `backend/` → 重打包。

## 4. 安装与生命周期(wanqi CLI)

```bash
# 安装(校验 → 登记市场 → 解包 backend → 路由注册)
wanqi bundle install ~/Code/dsh-go-miniprograms/dist/wx5b8e2f4a9c1d7e60-10.zip

# 升级(停旧 → 换目录,旧版留作 previous → 起新 → health → 更新路由;失败自动退回 previous)
wanqi bundle upgrade ~/Code/dsh-go-miniprograms/dist/wx5b8e2f4a9c1d7e60-11.zip

# 回滚(current 指回 previous → 重启 → 重注册路由)
wanqi bundle rollback <appId>

# 卸载(停进程 + 反注册路由;data/logs/DB 保留,重装即恢复)
wanqi bundle remove <appId>
```

install 校验:① `main/` + `bundle.json` 存在;② `appId` 与包内一致;③ `version.code` 严格递增(仅升级时);④ `backend.start` 入口文件在包内;⑤ app 包 ≤10MB。任一不过直接拒收,旧版不受影响。

有 backend 的应用,server 会:动态端口 spawn(注入环境变量三件套)→ 打 `backend.health` 到 200 才算装好 → 按 `gateway` 前缀自动注册路由;server/主机重启后自动重拉所有已装后端。

## 5. 重发策略(重要)

- **常规改版**:`version.code` +1,`bundle upgrade` 上去。
- **重发同版本**(内容修正、迁移重装):`version.code` 不变,先 `remove` 再 `install`——remove 保留 data/logs/DB,install 同版本号直接装回。Bundle v1 的 install 对新装(市场里没有该 appId)不校验版本递增,所以这条路是通的。
- 回滚只到上一版(`previous/`),更早的版本靠重发同版本号走 remove/install。

## 6. 本仓 12 个示例对照表

维护 `~/Code/dsh-go-miniprograms/` 时以此为准(appId 与 `project.config.json` 强制一致;版本 = 重发基线):

| ~/Code/dsh-go-miniprograms/ 目录 | appId | 名称 | code | version | frontend.entry | backend |
|---|---|---|---|---|---|---|
| flappy-bird | `wx5b8e2f4a9c1d7e60` | Flappy Bird | 10 | 1.1.6 | `game` | – |
| glm-quota | `wx2f8a4c6e1d3b5a79` | GLM用量 | 14 | 1.2.5 | `pages/index/index` | – |
| three-bench | `wx3d7b2f91c4a8e5d6` | Three 3D 基准 | 13 | 1.0.11 | `game` | – |
| webbench-3d-webview | `wx9d4e6a2c8b1f7e35` | WebView 3D 基线 | 4 | 1.0.2 | `pages/index/index` | – |
| weui | `wx92269e3b2f304afc` | WeUI for 小程序 | 73 | 1.0.72 | `example/index` | – |
| shuangpin-coach | `wx3d8b6f2a9c4e7d15` | 双拼教练 | 20 | 1.4.4 | `pages/home/home` | – |
| star-drift | `wx8c4e2f6a9d1b7e53` | 星际穿行 | 10 | 1.0.8 | `game` | – |
| darkmode-demo | `darkmode-demo` | 深色模式演示 | 3 | 1.0.2 | `pages/index/index` | – |
| sys-monitor | `wx8d31a5f0c94b27e6` | 系统监视器 | 8 | 1.3.2 | `pages/index/index` | ✓ |
| ledger | `wx7c3e9d2a1b4f5e68` | 记账本 | 4 | 1.0.3 | `pages/list/list` | – |
| road-hop | `wx5f8a2d7c9e1b4f30` | 过马路 | 2 | 1.0.0 | `game` | – |
| audio-test | `wx3a7f2c9e1b8d4f56` | 音频验收 | 1 | 1.0.0 | `pages/audio/audio` | – |

- `~/Code/dsh-go-miniprograms/dist/` 是上表的发布产物(`<appId>-<code>.zip`),`main/` 在根 + `bundle.json`(sys-monitor 另有 `backend/`)。
- 唯一带 backend 的是 sys-monitor:daemon 入口 `daemon/src/main.ts`,读 `APPHUB_PORT`(优先)绑 `127.0.0.1`,`GET /healthz` 免鉴权恒 200。双拼教练虽留有 `daemon/` 目录但**未使用**,不写 backend 段。
- 改了某包:源码目录里同步改 `bundle.json` 的版本号,按 §3 重新产出 zip 到 `~/Code/dsh-go-miniprograms/dist/`。

## 7. 常见坑

- `frontend.entry` 写错 → 手机端打开白屏;小程序取 `app.json` `pages[0]`,小游戏固定 `game`。
- 后端写死端口 → 动态分配失效,spawn 后 health 打不通;必须读 `APPHUB_PORT`。
- 后端依赖装在安装期 → 没有安装期,依赖必须随包;`.node` 原生扩展直接拒收。
- 忘记改 `version.code` 又走 upgrade → 拒收(版本倒退/持平);确要同版本重发走 remove → install。
