# Road Hop（过马路）· 3D 体素小游戏 · 团队接口契约（v1）

Dimina **小游戏格式**（`compileType: "game"`），单机离线，three.js WebGL 3D 渲染。
复刻 Crossy Road 玩法（点按跳一格、左右滑变道、车流躲避、计分），**名字/美术/代码全自研**。
工程工作区：`~/Documents/deepseek-harness/default-workspace/road-hop-build/`
（源码先在工作区开发，lead 负责同步进 `~/Code/dsh-go-miniprograms/road-hop/` 并编译发布——队员**不要写工作区以外的路径**。）

## 分工（严格互不相交，只准写自己的文件）

| 成员 | 文件 |
|---|---|
| engine-dev | `src/engine.js`、`src/constants.js`（+ `test/engine.test.js` 纯逻辑自测） |
| render-dev | `src/renderer.js`、`preview/`（预览 mock + 真实渲染器） |
| shell-dev | `game.js`、`game.json`、`project.config.json`、`src/main.js`、`src/store.js`、`src/theme.js`、`build.sh` |
| lead | `CONTRACT.md`、icon、同步源码、编译/打包/发布、真机验证 |

## 运行时 API（three-bench 真机验证过的配方，直接用）

- `wx.getSystemInfoSync()` → `windowWidth/windowHeight`（css px）、`pixelRatio`
- `wx.createCanvas()` → 传给 `THREE.WebGLRenderer({canvas, antialias:true})`；`getContext('webgl2')` 可用（fallback webgl）
- **分辨率铁律（v1.0.9 黑屏教训，禁止违反）**：
  - 禁止手动预设 `canvas.width/height`（three 构造器会把它读进内部状态，setPixelRatio 触发的内部 setSize 二次放大，撞 shim 4096 上限 → RangeError 黑屏）
  - 正确姿势：`renderer.setPixelRatio(dpr)` → `renderer.setSize(cssW, cssH, false)`
  - `dpr = Math.min(pixelRatio||2, 3, 4096/Math.max(cssW,cssH))`
- rAF：`canvas.requestAnimationFrame(cb(tMs))`（挂在 canvas 上，不是 globalThis；渲染层 vsync 驱动，时间戳单调）
- 触摸：`wx.onTouchStart/Move/End/Cancel(cb)` → `e.changedTouches[0].clientX/clientY`（css px）
- 存储：`wx.getStorageSync/setStorageSync`（必须 try/catch + 内存兜底，见 shell 的 store.js）
- 资产：**不引外部文件为主**（体素模型程序化拼 BoxGeometry，零资产最稳）。如确需文件资产：GLTF 走 `THREE.FileLoader.prototype.load` 补丁拦 `pkg:/` 前缀走 `wx.getFileSystemManager().readFileSync`；贴图 src 翻译成 `https://appassets.androidplatform.net/<appId>/main/assets/...`；`.gltf` 必须 utf8 字符串 parse；禁 Blob/URL.createObjectURL（QuickJS 没有）
- 逻辑层 QuickJS：**esbuild 全链路 ESM 打包成 CJS bundle**（`game.js` 里 `require('./js/bundle.js')`）；源码内禁 CJS/ESM 混用导致双实例——校验：bundle 里 `'Multiple instances'` 出现 ≤1 次；禁 node API、禁 TextDecoder 依赖（垫片已有桩）

## 尺寸与坐标

- 逻辑坐标 = css px；世界坐标自定（tile = 1 世界单位）
- dpr 与位图尺寸见「分辨率铁律」，渲染器初始化模板：
  ```js
  const cssW = info.windowWidth, cssH = info.windowHeight
  const dpr = Math.min(info.pixelRatio || 2, 3, 4096 / Math.max(cssW, cssH))
  renderer.setPixelRatio(dpr); renderer.setSize(cssW, cssH, false)
  ```
- 相机：OrthographicCamera（Crossy Road 同款），竖屏可见 ~9-10 列

## 玩法规则（MVP）

- 网格世界：车道按行生成，草地区（安全，随机树）/ 马路（车辆双向通行）/ 后续可加水道木头
- 操作：**点按 = 向前跳一格**；**左右滑 = 横向变道一格**（跳跃 120ms 补间）
- 碰撞：AABB（玩家 0.6×0.6 vs 车 1.6×0.9）；被撞/滞留太久了乌鸦带走 = 死亡
- 计分：前进到达的最大行数；best 分数经 store.js 持久化
- 相机：跟随玩家前进方向，正交视角，玩家位于屏幕下 1/3

## 里程碑

- M1（当前）：预览图 → 用户拍板视觉（render-dev 出 `preview/preview.png`，真 three.js 渲染，非示意图）
- M2：静态世界 + 跳跃 + 相机跟随（模拟器可跑）
- M3：车流 + 碰撞 + 计分 + 死亡重来 + best
- M4：icon（用户拍板后）→ 打包发布上架 → 冒烟

## 铁律提醒（skill 原文）

UI 已确认前**禁止写游戏正式代码**（M1 预览 mock 除外——预览本身是拍板材料）；发版 `--version-code` 严格递增；zip 根必须 `main/`；icon.png 必须进 `main/`。
