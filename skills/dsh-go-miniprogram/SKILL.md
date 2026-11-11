---
name: dsh-go-miniprogram
description: 给万器(wanqi)平台开发、编译、打包、安装、更新一个 Dimina(星河)小程序,并在真机调试容器行为。覆盖全流程:用微信小程序格式写源码(~/Code/dsh-go-miniprograms/,项目根维护 bundle.json)→ dmcc 编译 → zip 打包(main/ 在根 + bundle.json,后端可选 backend/)→ wanqi bundle install 装进万器 server(:7610 生产/:7620 测试,路由自动注册)→ 手机市场安装/自动升级 → 调试(vConsole/logcat/沙盒文件)。用户要「写一个小程序上架市场」「改某个小程序再发一版」「调试小程序容器(返回/胶囊/存储)」时先加载本技能。注意分工:契约 v1 单文件 HTML 应用(如引擎侧 ledger)走的是另一套 AppletScreen 容器,见 docs/apps/container-contract.md,不要混用两套发布格式。Develop, compile, package, install and update a Dimina mini-program for the wanqi platform.
whenToUse: The user wants to create, modify, install or debug a wanqi mini-program (Dimina/星河 Bundle) — 上架市场、发新版本、调返回/胶囊/存储行为. For the engine-side single-file HTML applet container (contract v1) use docs/apps/container-contract.md instead.
---

# 万器小程序开发(写→编译→打包→安装→更新→调试)

## ⚠️ 铁律:UI 改动必须先出预览图等用户确认(2026-11-10 定,不可跳过)

凡涉及 UI 的改动——新页面、改样式/配色、弹层、图标、交互——**写代码之前**必须先出预览图发给用户,等用户明确确认后才动手开发。禁止"方案说一声就开改"。
仅数据/逻辑/构建链改动不受此限。预览图标注:改前 vs 改后、涉及的具体视觉差异。架构/流程图用 d2-diagrams skill;**图标/界面类直接渲染实物 PNG 对比图**(示意工具画不出真实观感,见 §3.1)。

## 0. 架构:先搞清谁是谁

```
写源码(微信格式)  ~/Code/dsh-go-miniprograms/<项目>/   ← 项目根维护 bundle.json(应用清单)
   │ dmcc 编译(fe/packages/compiler)
   ▼
main/ 产物(app-config.json + logic.js + pages_*.js/css)+ icon.png → zip(bundle.json 在 zip 根 + main/;后端可选 backend/)
   │ wanqi bundle install(校验 → 登记市场 → backend 解包 → 路由自动注册)
   ▼
万器 server:生产 :7610(~/dsh/apphub/config.json)/ 测试 :7620(wanqi/server/config.local.json)
   → /api/v1/apps + /apps/<id>/manifest.json
   │ 手机 dsh-go App:市场页安装(无底包首装)/已装旧版后台升级(updateManifestUrl)
   ▼
Dimina 容器(DiminaActivity,独立 task;JitPack com.github.didi.dimina:dimina:1.8.1)
   桥:app/.../dimina/DiminaPlugin.kt ↔ app/lib/ui/applet/dimina/dimina_host.dart
```

- 万器 server 跑在本机(dart bin/apphub.dart + MariaDB):**生产 :7610** 由 launchd 托管(Label `app.dsh.apphub.server`),**测试 :7620**(Label `app.dsh.wanqi-test.server`,独立库 apphub_test + 数据目录 ~/dsh/wanqi-test);AppHub 专属引擎 :7611(Label `app.dsh.apphub.engine`)。重启 DSH/电脑不掉。
- 真机访问走 SSH 隧道(SshHostLink._ensureAppHubForward 自动带的固定 7610 转发,M4);214 仿真器走 adb reverse + ssh -R。
- **两套容器别混**:市场 Dimina 包跑 DiminaActivity;引擎侧单文件 HTML 应用跑 AppletScreen(契约 v1,胶囊/返回是 Flutter 浮层)。本技能只管 Dimina 包。
- **打包/安装规范**:`~/Code/wanqi/docs/design-bundle-spec.md`(Bundle v1 规范)+ `~/Code/wanqi/docs/pack-and-install.md`(作者视角手册,含 12 包 appId/版本对照);旧流程(publish/route add/手动 zip 无清单)已退役。

## 1. 写代码(微信小程序格式)

源码放 `~/Code/dsh-go-miniprograms/<项目名>/`,必需文件:

- `project.config.json`:**`appid` 是小程序的唯一身份**(Dimina 沙盒、市场都按它索引),格式 wx+16位hex(如 `wx7c3e9d2a1b4f5e68`);`projectname` 是展示名。**上架后不要改 appid**,改了=新应用。
- `bundle.json`(项目根,与源码同仓维护;Bundle v1 清单,install 校验它):`spec:1`、`appId`(必须与 project.config.json 一致)、`name`、`version:{code,name}`(**code 严格递增,升级判定唯一依据**)、`frontend.entry`(启动页=app.json pages[0],小游戏="game")、带后端再加 `backend:{start,health,gateway,ai}`。字段语义见 pack-and-install.md §2。
- `app.json`:`pages` 数组,**第一个页面=启动页**;`window.navigationBarTitleText` 等。
- `app.js` / `app.wxss` + `pages/<页>/<页>.{js,json,wxml,wxss}`。

写法约定(参考现成 Demo `~/Code/dsh-go-miniprograms/ledger/`,两页:列表→记一笔):

- 数据用 `wx.setStorageSync/getStorageSync`(Dimina 已实现);**必须 try/catch + 内存兜底**(见 ledger 的 utils/store.js),storage 不可用时同会话内仍可用。
- 页面间跳转用 `wx.navigateTo`/`wx.navigateBack`;**返回语义**(multiTask 开启后):子页返回=finish 弹掉这一层;根页返回=隐藏小程序回到宿主 App(保栈,下次秒回)。多页应用才有「层层返回」可看。
- 图标/图片放项目内会被编译器收编(assets);不要引用外链(Dimina 壳有域名校验)。
- 想加样例数据:onLaunch 里播种(ledger 就是这么做的)。
- 3D/重图形(three.js 等):**默认 game 容器 + road-hop 自研引擎模板**(天然离线,过马路 v1.0.0 实机验证无性能问题),见 §11;仅「搬现成网页内容」场景用 web-view 路线。

## 2. 编译(dmcc)

```sh
cd ~/Code/dimina/fe          # 依赖已 pnpm install 过;要求 node>=22.22.3(本机 22.x OK)、pnpm 12.2.0
node packages/compiler/src/bin/index.js build \
  -c ~/Code/dsh-go-miniprograms/<项目> -s /tmp/<项目>-dist
```

- 产物:`/tmp/<项目>-dist/<appid>/main/`(app-config.json、logic.js、pages_*.js/css)。
- 不加 `--no-app-id-dir` 时产物带 appId 目录;**打 zip 时要把 main/ 放 zip 根**(bundle.json 也在 zip 根,见 §3.2)。
- `pnpm compile` 会编 examples 下全部项目并写 container/public(那是 web 容器 demo 的流程,发原生包不需要)。
- 改动后重编同命令即可;`-w` 可挂监听。

## 3. 图标与打包

### 3.1 图标(icon.png)从哪来 —— 默认先问用户,他说让你画才画

- **每个上架小程序必须有 `main/icon.png`(512×512)**;server 安装时自动抽取为市场图标并回 `iconUrl`,包里没带则继承上一版(见 §5)。
- **默认先问用户**(首次上架/打包时):「图标你自己提供,还是我画?」——**不要默认替用户画**;用户明确说让你画,才进下面的画图流程。
- **用户给素材**:收 512×512 PNG,大图等比缩小可以,小图不放大会糊,非方形的先裁;进包前给用户过目。
- **用户说让你画**:图标属 UI,吃铁律——先出 2~3 颗候选的实物预览图,渲染成一张 PNG 对比图发用户拍板(直接渲染真图标,不走 d2,示意工具画不出真实观感),确认后才落盘。
- **画法规范(方案A·实底彩块,钉死的变量)**:120×120 画布、圆角 27%(32.4)、每 app 一个固定色相实底(全不透明,禁透明/玻璃感)、纯白几何字形、线宽 6.5~9、字形外扩留白 ≥45/120、60px 下仍可辨识;色相选型参考既有 8 颗(画法源码:dsh-Go `app/lib/ui/applet/hub_app_icon.dart`)。
- **落盘两条路**:
  1. 常驻 app(字形值得进兜底库):在 `hub_app_icon.dart` 的 `_specs` 加语义键 + painter,并把键补进 `app/test/icons/hub_app_icon_test.dart`,再用 `rasterizeHubAppIconPng(key, size: 512)` 栅格出 PNG——bundle 图标与 App 内兜底渲染像素同源;
  2. 一次性 app:手写 SVG 画稿(120 画布)→ 包一层 512×512 HTML → `node ~/.dsh/skills/web-browser/pw.mjs shot <file> <out.png> --width 512 --height 512` 渲染(本机 Chrome 直跑 headless 会被沙箱拦,必须走 pw.mjs)。
- 成品存 **项目根 `icon.png`**,打包时 cp 进 `main/`(下步)。

### 3.2 打包(源码 + bundle.json → zip)

```sh
cp ~/Code/dsh-go-miniprograms/<项目>/icon.png /tmp/<项目>-dist/<appid>/main/   # bundle 图标(512px),来源见下
cp ~/Code/dsh-go-miniprograms/<项目>/bundle.json /tmp/<项目>-dist/<appid>/     # 应用清单放 zip 根
cd /tmp/<项目>-dist/<appid> && zip -qr /tmp/<项目>-<版本>.zip bundle.json main
```

- zip 结构:**`bundle.json` 在 zip 根 + `main/`**(install 门禁校验两者;缺 bundle.json 直接拒收)。带后端再加 `backend/`(见 §9)。
- 项目根的 `bundle.json` 与源码同仓维护;**改了任何东西要发新版:`version.code` +1**(重发同版本走 remove→install,见 §5)。
- 校验:`unzip -l` 第一层必须是 `bundle.json` + `main/`,且 `main/icon.png` 在列。

## 4. 安装(wanqi CLI)

```sh
cd ~/Code/wanqi/server
PUB_CACHE=~/Code/wanqi/.pub-cache ~/dev/flutter/bin/cache/dart-sdk/bin/dart run bin/wanqi.dart \
  bundle install /tmp/<项目>-<版本>.zip \
  --server http://127.0.0.1:7610 \
  --key $(python3 -c "import json;print(json.load(open('$HOME/dsh/apphub/config.json'))['publisherKey'])")
```

- 打测试 server :7620:`--server http://127.0.0.1:7620 --key $(… wanqi/server/config.local.json …['publisherKey'])`。
- install = 门禁校验(bundle.json/main 存在、appId 一致、versionCode 递增[仅升级]、backend.start 入口在包内、≤10MB)→ 登记市场 → backend 解包 → **网关路由按 bundle.json 的 `backend.gateway` 自动注册**(不需要手动加路由)。校验不过直接拒收并报 errcode,旧版不受影响。
- 上架确认:`curl -s http://127.0.0.1:7610/api/v1/apps` 里出现且 versionCode 正确。
- 市场页安装/打开用 `frontend.entry` 当启动路由;**填错路由会白屏**,必须写全(如 `pages/list/list`,不带 .html 后缀)。
- 四命令:`bundle install <zip>` / `bundle upgrade <zip>`(同端点,server 强制 versionCode 递增)/ `bundle rollback --app <appid>`(回滚到上一版)。

## 5. 更新版本

1. 改源码 → 改 `bundle.json` 的 `version:{code,name}`(**code 必须严格递增**,客户端拿 manifest 的 versionCode 和本地比,不增不升级)→ 重编译 → 重打包(zip 文件名带新版本号便于追溯)→ `bundle upgrade` 安装;
2. **图标随包走**:zip 里有 `main/icon.png` 就自动成为市场图标,包里没带则**自动继承上一版图标**(服务端抽包回 iconUrl);
3. **升级完全由框架负责**:小程序侧零升级代码,不要写 `wx.getUpdateManager` 逻辑(glm-quota 已拆除)。容器自动检测+下载,原生弹「发现新版本」问用户,确认才换包冷重启;拒绝则下次打开再问;
4. 手机端现象:市场页该应用显示「更新」,点开 → 容器弹窗确认 → 立即冷重启到新版;升级里程碑(installed/applied/declined/failed/ready)经 DiminaPlugin 转发 Flutter,市场页按真实状态刷新。
5. **同版本重发**(内容修正/迁移重装,code 不变):先 `bundle remove --app <appid>`(停进程+撤路由,**data/logs/DB 保留**)再 `bundle install` 同版本 zip。直接对已装 app install 同版本会被 409 版本门槛拒收。

## 6. 深色/浅色模式适配(声明门禁制;2026-11-09 sys-monitor v6 实操)

容器按「声明门禁」工作:app.json 声明 `"darkmode": true` 才有主题;**未声明包逐字节
原样**(壳层色直通、WebView 不被染黑、systemInfo.theme 恒 null,微信语义=永远浅色),
不会坏,只是不跟随系统深浅色。适配分两层:

- **壳层(导航栏/页面背景/系统导航栏/WebView 底/TabBar 四色)**:app.json 声明
  `"darkmode": true` + `"themeLocation": "theme.json"`,window/tabBar 色值全写
  `@key` 引用;项目根放 theme.json(light/dark 两套同名变量表)。页面 json 的
  `backgroundColor` 也支持 `@key`(容器 mergePageConfig 会解析)。dmcc 容错:
  theme.json 缺失/坏 JSON 会丢弃 darkmode 降级为未适配。tabBar 的 iconPath PNG
  不随主题换(容器只解析文字四色)。标准样例:`~/Code/dimina/test-fixtures/darkmode-demo`;
  完整实战:`~/Code/dsh-go-miniprograms/sys-monitor`(v6,commit 45b932b)。
- **内容层(wxss/canvas)必须 JS 驱动**:容器宿主 targetSdk<33,WebView 的
  `@media(prefers-color-scheme)` 恒报 light,**wxss 媒体查询路线不可用**。套路:
  ① `utils/theme.js` 提供 `current()/palette()/attach(page)`——attach 读
  `wx.getSystemInfoSync().theme` 挂初值并注册 `wx.onThemeChange`(容器两 API 都已
  实现),返回 detach 供 onUnload 调;② 页面根节点
  `<view class="page {{theme==='dark'?'dark':''}}">`,app.wxss 定义
  `.page{--bg/--card/--fg/--fg2/--fg3/--track/--divider/...}` 变量组 +
  `.page.dark` 整组覆盖,页面 wxss 一律 `var(...)`,`page{}` 节点不再写死背景色;
  ③ canvas 里 JS 写死的中性色(轨道/网格线/标签)从 `palette(theme)` 取,
  applyTheme 时用缓存的 lastPct/points 重画;语义色(品牌蓝橙红)明暗同值,
  不进调色板。
- **已知边界**:声明后容器对 WebView 开 ForceDark AUTO 兜底算法反转——自绘深色
  页面(含 canvas)在深色系统下实测 no-op(2026-11-09 sys-monitor v6 真机验证:
  壳层/内容层/canvas 均正常);切换时效:壳层 onConfigurationChanged 即时翻,
  内容层跟 onThemeChange 翻。

## 7. 调试

- **vConsole**:DiminaPlugin.kt 里 `setDebugMode(true)`(当前常开),小程序里能直接看 console/network。
- **logcat**:`adb logcat | grep -iE "dimina|miniapp"`。
- **沙盒文件**:装的是 `.local` 后缀包时 `adb shell run-as io.github.ccch1mneyyy.dsh_app.local ls files/jsapp/<appid>/`(config.json 记 versionCode;**别用无后缀包名,run-as 会报 unknown package**)。
- **真机链路**:手机开无线调试 → `adb pair` 配对码流程 → `adb connect`(两个端口别混用,`export ADB_MDNS=0`);214 仿真器:`ssh weimingchen@192.168.1.214` 后用其 `~/Library/Android/sdk/platform-tools/adb`。
- 市场打不开(「AppHub 未连接」):先在 Mac 上 `curl :7610/api/v1/apps`;真机看 ssh 隧道是否带着 7610(`adb reverse --list` / SshHostLink 日志)。

## 8. 容器行为改造(改 Dimina 本体时)

- 想改容器 UI/行为(胶囊、弹层、主题):源码化链路是 **publishToMavenLocal 循环**(AGP 9.4/9.1 复合构建互斥,不能 includeBuild):改 `~/Code/dimina/android/dimina` → `cd ~/Code/dimina/android && GRADLE_USER_HOME=~/dev/.gradle-dsh ./gradlew :dimina:publishToMavenLocal :engine_qjs:publishToMavenLocal`(不带这个 GRADLE_USER_HOME 会撞 ~/.gradle/init.gradle 的 PREFER_SETTINGS 报错) → 重编 app APK(`tooling/build-apk.sh`,见「本机签名与装机」记忆)。原生壳层弹层(菜单 sheet/wx.showActionSheet/wx.showModal)已全部深浅色化(2026-11-09,5bb040a+03e0e45):一律跟系统深浅色,宿主显式自定义色优先;新增面板别写死 Color.White/Black。菜单弹层头部图标走「iconKey→宿主主题色栅格 PNG→MiniProgram.iconPng」通道(dsh-go 099dfa10 + dimina 00bebf4/0f3282b),SDK 不复刻字形;**给 MiniProgram 加字段必须同步三处**:bean 字段+Parcelable、launch() 的 putExtra、getMiniProgramFromIntent() 的字段化重建——intent extras 是逐字段重建的,漏了任何一处新字段就会在 Activity 侧静默丢失(0f3282b 教训)。已实测边界:容器运行中切系统深浅色,壳层导航栏/页面背景即时翻,但胶囊配色与 JS 侧(wx.onThemeChange)不跟翻,冷启动/重进小程序才正确——是框架既有边界,非面板代码问题。
- 返回/隐藏已配好:`setEnableMultiTask(true)`(DiminaPlugin.kt)是**必须的**,关掉它根页返回会直接销毁整个小程序(SDK 的 hideMiniProgram 在非多任务下走 exitMiniProgram 分支)。
- SDK 可用 API:`hideMiniProgram(appId)`(保栈隐藏)、`closeMiniProgram`、`setShowCapsule/setCapsuleBackgroundColor/setCapsuleIconColor`(胶囊是 SDK 自绘 MiniProgramCapsuleButton,在 DiminaActivity.kt)。
- 我们自己的胶囊行为(触摸收起/6s 展开)在 app/lib/ui/applet/applet_capsule.dart(只用于 html 契约容器),移植到 Dimina 侧=改 DiminaActivity 那段 Compose。
- Dimina 本地适配全量存档:`~/Code/wanqi/patches/dimina-series/`(25 patches,树 SHA 对账无损,git am 应用法见其 README);dsh-Go 宿主侧同理见 `patches/dsh-go-series/`。

## 9. 带后端的小程序:backend/ 随包 + server 托管(sys-monitor 范式)

小程序要访问自建后端 daemon 时,**只走万器网关,别直连后端端口**——直连在真机
上必挂(手机到不了主机的 loopback,只有仿真器 adb reverse 能通):

- **访问路径(固定基址)**:小程序 BASE = `http://127.0.0.1:7610/api/v1/apps/<appId>/…`,
  请求 `<BASE>/stats` 这类原路径 → 网关按路由表反代到 target。设备侧:仿真器
  `adb reverse tcp:7610 tcp:7610`;真机走 SSH 链路自动绑定的**固定 7610** 转发。
- **路由自动注册**:backend 段写进 bundle.json——
  `"backend":{"start":"node dist/main.js","health":"/healthz","gateway":["/"],"ai":false}`,
  install 时 server 按 `gateway` 前缀自动注册路由,**不再手动加路由**。网关语义:超时 504 /
  后端挂 502 / 限速 429,默认 rpm 120(轮询类先算预算:sys-monitor 每 5s 打 stats+processes = 24rpm)。
- **后端随包 + server 托管(sys-monitor 范式,2026-11-11 起)**:daemon 源码进
  `<项目>/daemon/`,**预编译成 dist 零运行时依赖**(tsconfig.build.json + rewriteRelativeImportExtensions,
  参考 `examples/sys-monitor/daemon/`),zip 里放 `backend/dist + backend/src + backend/package.json`;
  install 时 server 动态挑空闲口、按 `backend.start` 拉起(注入 `APPHUB_PORT/APPHUB_APP_ID/APPHUB_DB_URL`,
  **daemon 必须读 APPHUB_PORT 且只绑 127.0.0.1**)、打 `backend.health` 到 200 才算装好、崩溃看护自动重启、
  server 重启自动重拉。**不再手写 launchd plist**——sys-monitor 旧的手写托管已退役。
- **改后端后**:重新打 zip(backend 内容变了就 code+1)走 §5 发版;只改 daemon 运行态可不发版(重启由 server 看护管理)。

## 10. 已知坑(踩过的)

- `dart` 不在 PATH → 用 `~/dev/flutter/bin/dart`(或其 `bin/cache/dart-sdk/bin/dart`),`PUB_CACHE` 指仓库内(如 `~/Code/wanqi/.pub-cache`);wanqi CLI/编译类命令在 DSH 沙箱会话里要过审批(danger-full-access),纯读不受限。
- 会话工作区、部分临时区之外(含 ~/Code/**、~/.dsh/**、~/dsh/**)的写操作都要过沙箱审批;纯读不受限。
- zip 里 `bundle.json` 或 `main/` 不在根 → install 门禁直接拒收;漏 bundle.json 也会拒收(不再收旧格式)。
- `bundle.json` 的 `version.code` 没递增就 upgrade → 409 拒收,现象是「改了没效果」;同版本重发必须先 remove 再 install。
- 编译报某 API 不存在:Dimina 未实现的 wx.* 会运行时报错,先在真机 vConsole 里确认再写。
- server 没起/行为异常:生产 `launchctl kickstart -k gui/$(id -u)/app.dsh.apphub.server`、测试 `…app.dsh.wanqi-test.server`、引擎 `…app.dsh.apphub.engine`;检查 `lsof -iTCP:7610 -iTCP:7620 -iTCP:7611 -sTCP:LISTEN`;测试 server 日志 `~/dsh/wanqi-test/wanqi-test-server.log`。
- 测试 server :7620 与生产 :7610 完全隔离(独立库 apphub_test + ~/dsh/wanqi-test),新流程先打 :7620 验证再上 :7610;**:7620 只放测试数据**。

## 11. 3D/重图形场景选型(2026-11-10 二次定档:3D 小游戏默认 game 容器自研引擎,用户拍板)

**3D 小游戏默认 = game 容器 + road-hop 自研引擎模板**(three.js + 几何缓存渲染器,资源全进 zip 天然离线)。「过马路」road-hop v1.0.0 已上架并仿真器全链路验证(安装/跳跃/计分/碰撞死亡/重开),**实机未发现性能问题**——早期对照「V8 26.6fps vs 桥接 18.5fps」的差距在真实玩法下不构成体验问题,桥接税对轻量 3D 场景无感。

- **标准模板(新 3D 游戏以它为底)**:源码 `~/Code/dsh-go-miniprograms/road-hop/`,构建工程 `default-workspace/road-hop-build/`(CONTRACT.md 契约 + build.sh 一键构建)。换玩法改 engine、换皮改 renderer、壳照抄。**要用现成 glTF 模型**则以 star-drift 为底(源码 `~/Code/dsh-go-miniprograms/star-drift/`,工程 `default-workspace/star-drift-build/`),资产管线坑见下方专条。
- **现成 glTF 模型管线(QuickJS 坑,star-drift v1.0.7 实战)**:垫片只有 `document.createElementNS`(非 NS 版 `document.createElement` 不存在!),2D canvas 一律 `createElementNS(ns,'canvas')`→wx.createCanvas;**≥512² 的 2d canvas → CanvasTexture 桥接静默产黑**(getImageData 也坏,512² 以下正常)→大程序化贴图一律 DataTexture 逐像素 RGBA(equirect 256×128 足够);.gltf 必须 `readFileSync(path,'utf8')`(漏了→TextDecoder 垫片 decode 空→JSON.parse('') 报 Unexpected end of JSON input);**GLTFLoader.parse 带外部资源(bin URI/贴图 URL)在 QuickJS 会挂起不回调**(资源全部 OK 也不落定)——正确姿势:自己 utf8 读 JSON→剥 images/textures/材质贴图引用→bin base64 内联 data URI→零外部依赖 parse→贴图自己预载(appassets img 已验证 OK)parse 后遍历 mesh 手工挂 map;FileLoader 补丁必须同时拦 `pkg:/` 和 `data:` 两种 URI(内联 buffer 走 data:,回落会用到 fetch→QuickJS 没有);base64 手写查表(无 btoa/atob);readFileSync 会返回 -1(冷启竞态)→重试 3 次×300ms;模型源:Quaternius CC0(GitHub 镜像仓库直下,官网 Google Drive curl 拿不到)。
- **模板三层**:① `engine.js` 纯逻辑状态机(ESM、零 wx/three 依赖、rng/seed 可注入、getState 纯数据快照、node 自测断言);② `renderer.js` 顶点色合并几何(每行 1~2 mesh/每车 1 mesh/单 Lambert 材质,在屏 ~60 对象)+**几何按内容 key 缓存、引用计数归零才 dispose**+OrthographicCamera 玩家居中 67% 高+分辨率铁律在内部执行;③ HUD 无 DOM:**第二块 wx.createCanvas() 画 2D → CanvasTexture 贴回唯一 WebGL canvas**(Dimina 已验证可用,拿不到降级无 HUD 不崩);④ `store.js` best 持久化 try/catch+内存兜底;⑤ `build.sh` esbuild 全链路 ESM→CJS + 'Multiple instances' ≤1 校验。
- **团队模式(有效,复用)**:CONTRACT.md 契约先行(engine/render/shell 分文件严格互不相交)→ **真 three.js 渲染的预览图用户拍板后**才写正式代码 → 三队员并行 → lead 编译发布+仿真器 adb 驱动验证。
- **web-view 路线降级为备选**:适用「已有现成网页/three.js 内容直接搬」或非游戏类 3D 展示(参考 `webbench-3d-webview/`,一行 `<web-view>` 指网关 URL,后端见 §9);内容在后端,要离线得配 Service Worker,依赖链长。
- **技术坑不变(两条路都看)**:game 容器位图**只交给 three 管**(`setPixelRatio(dpr)` → `setSize(cssW,cssH,false)`,绝不能手动预设 canvas.width/height——二次放大撞 shim 4096 上限黑屏,dpr 钳 `min(dpr,3,4096/max(cssW,cssH))`);esbuild 单实例('Multiple instances' ≤1);FileLoader 补丁 + utf8 parse;assets 手动进 main/;zip 根 bundle.json+main/;web-view 路线则标准 `setPixelRatio(devicePixelRatio||2)`。

## 12. 音频/音效(2026-11-11 定档:短音效必须「每播新建实例」)

**根因**:MediaPlayer 实例一旦 `stop()`/`reset()` 过,再对它 `prepareAsync` 会**静默挂死**——onPrepared/onError 均不回调、无日志、无 AudioTrack(API 35 + vivo 媒体栈实测;新建实例的首次 prepare 完全正常 ~30ms)。容器 AudioApi 的 reprepare 已于 2026-11-11 改为销毁重建(dimina main),**但旧容器 APK 仍在用户手机上,小程序侧必须自保**。

- **正确姿势(短音效 SFX,flappy-bird `src/sfx.js` v1.1.5 为参考实现)**:播放时 `destroy()` 旧实例 → `createInnerAudioContext()` 新实例 → 设 `src` → `play()`(新实例走 waitUntilPrepared→onPrepared→自动起播)。**禁止**「预建实例 + stop/play 复用」,也**禁止**播放前重发 setSrc(会把 prepare 中的播放器 reset 掉,打断 pending-play 链)。
- 预加载:启动时对每个音效建一次实例预 prepare 有效(~30ms),但播放时仍要新建实例,别复用。
- **症状识别**:预载成功但播放无声 + 无任何错误事件 + logcat 零 AudioTrack + NuPlayerDriver created 后无下文 → 就是这个坑,换重建姿势。
- 已知次要坑:game 容器里原生音频事件(onPlay/onCanplay/onError)**不回传 JS**(监听不触发),不影响发声;别依赖音频事件做游戏逻辑。
- 音效文件:程序化生成 WAV(16bit/22050Hz/mono,短音效共 ~57KB)即可,生成器参考 default-workspace/flappy-sfx-gen.js;**assets 手动进 main/(dmcc 不收编非 JS 资源)**,zip 根 bundle.json+main/。
- 调试利器(无声类问题):214 仿真器 + dimina 仓库 `:app` demo 宿主(debug 包,Application 即 `Dimina.init`,**没有 DSH 壳的引擎引导门**)+ `adb root` 直种包到 `/data/data/com.didi.dimina.demo/files/jsapp/<appid>/main/`(**必须 chown u0_aXXX,root 拷的文件 app 读不了→EACCES 秒退**)+ demo 的 setDebugMode(true) 开全量 LogUtils;工作区脚本 `flappy-emu-demo.sh`/`emu-test-device.sh` 可复用。214 仿真器 `input tap` 对原生 View 有效,Flutter 界面用 keyevent;DSH 壳(.local/.debug)在仿真器冷启动必过不了自家引擎门,绕开别修。
