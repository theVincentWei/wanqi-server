# Flappy Bird 小游戏 · 团队接口契约（v1 定稿，UI 已用户拍板）

Dimina **小游戏格式**（微信小游戏，`compileType: "game"`），单机离线，全 canvas 2d 自绘。
工程：`~/Code/dsh-go-miniprograms/flappy-bird/`

## 文件分工（严格互不相交，只准写自己的文件）

| 成员 | 文件 |
|---|---|
| engine-dev | `src/engine.js`、`src/constants.js` |
| render-dev | `src/renderer.js` |
| shell-dev | `game.js`、`game.json`、`project.config.json`、`src/main.js`、`src/store.js`、`src/theme.js` |
| lead | `icon.png`、编译/打包/发布 |

## 运行时 API（Dimina 小游戏容器已真机验证，直接用）

- `wx.getSystemInfoSync()` → `windowWidth/windowHeight`（css px）、`pixelRatio`、`theme`（可能 undefined）、`brand/model/system`
- `wx.createCanvas()` → 主屏 canvas；`canvas.getContext('2d')` → 2d 上下文
- `canvas.requestAnimationFrame(cb(tMs))` — **rAF 挂在 canvas 上**（不是 globalThis）
- `wx.onTouchStart/wx.onTouchEnd/wx.onTouchCancel(cb)` → `e.changedTouches[0].clientX/clientY`（css px）
- `wx.getStorageSync/setStorageSync`（必须 try/catch + 内存兜底）
- `wx.onThemeChange(cb({theme}))`、`wx.vibrateShort({type:'heavy'})`（均 try/catch 包裹）
- `wx.createInnerAudioContext()`（**v1.1.0 起容器已支持**，dimina aar 内置 JSSDK 1.0.75(76)+AudioApi）：`a.src = 'sfx/xxx.wav'` 包内相对路径 → `filesDir/jsapp/<appid>/main/sfx/`；赋 src 即原生预加载；`play()` 前 `stop()` 可快速重触发（stop 后 play 自动重 prepare）；缺 API/失败时 shell 的 `src/sfx.js` 已静默降级，业务代码直接调 `sfx.play(name)` 即可
- QuickJS 逻辑层：**CommonJS `require/module.exports`**（禁 import/export、禁 node API、禁 TextDecoder）
- `console.log`、`Date.now`、`Math`、`JSON` 可用

## 尺寸与坐标

- 逻辑坐标 = css px（`w=windowWidth, h=windowHeight`）；物理像素由 shell 设 `canvas.width=w*dpr, canvas.height=h*dpr` 并 `ctx.scale(dpr,dpr)`，dpr=`Math.min(pixelRatio,3)`。
- 所有游戏尺寸按比例定义：横向相对 `w`，纵向/速度相对 `h`，适配任意屏幕比例。

## src/constants.js（engine-dev）

`module.exports = { PHYS, COLORS_LIGHT, COLORS_DARK, MEDAL }`：

```js
PHYS = {
  GROUND_H:  0.115,  // ×h 地面总高(草+沙)
  BIRD_X:    0.28,   // ×w 鸟固定 x
  BIRD_R:    0.026,  // ×h 碰撞半径(宽容,小于视觉尺寸)
  BIRD_VIS:  0.045,  // ×h 视觉半径(身体椭圆长轴≈×h)
  PIPE_W:    0.155,  // ×w 管宽(下限 48px 由 engine clamp)
  PIPE_GAP:  0.185,  // ×h 缝高
  PIPE_SPACING: 0.62,// ×w 管水平间距
  SPEED:     0.50,   // ×w 管速 px/s
  GRAVITY:   2.40,   // ×h /s²
  FLAP_VY:  -0.72,   // ×h /s
  MAX_FALL:  1.35,   // ×h /s
  RESTART_DELAY: 500 // over 后忽略点击的 ms
}
```
（engine-dev 可微调数值优化手感，字段名不许改。）

`COLORS_LIGHT` / `COLORS_DARK` 见下方调色板表；`MEDAL = { GOLD_AT:60, SILVER_AT:30, BRONZE_AT:10 }`。

## src/engine.js（engine-dev）

```js
createEngine(w, h) → eng
```
- `eng.phase`: `'ready' | 'playing' | 'dying' | 'over'`
- `eng.bird`: `{ x, y, vy, rot }`（rot 弧度：上升≈-0.44，dying 时转到 +π/2；y=中心）
- `eng.pipes`: `[{ x, gapY, passed }]`（x=管左缘；gapY=缝中心 y；只保留屏内+1 根）
- `eng.score`：整数；`eng.groundY = h - GROUND_H*h`；`eng.groundOffset`（沙纹滚动偏移 px）；`eng.clouds`: `[{x,y,scale,speed}]`（视差云，engine 推进）
- `eng.flap()`：ready→`playing`（首次起飞，首根管 x=w*1.4 留准备距离）+ 跳；playing→跳；dying/over→忽略
- `eng.tick(dtSec)`：dt 上限 0.05s 由 shell 负责。ready：鸟原地正弦浮动+云慢速滚动；playing：重力/管移动/出屏移除/尾部补管/计分/碰撞；**撞管→dying**（管与地停滚，鸟继续坠落+rot→π/2，触地→over）；**playing 撞地→直接 over**
- `eng.reset()`：回 ready（保留 clouds）
- `eng.overAt`：进入 over 的时间戳（`Date.now()`），供 shell 判 RESTART_DELAY
- 引擎**不读不改** storage、不碰 wx.*、不碰 canvas（纯逻辑，可独立 node 跑冒烟测试）

## src/renderer.js（render-dev）

```js
draw(ctx, eng, pal, w, h, nowMs)   // pal 来自 shell 的 theme.js palette 对象
buttonRect(w, h) → {x, y, w, h}   // 「再来一局」按钮命中区(over 面板内)
```
- 每帧全量重绘。顺序：天空渐变→(dark 星星)→云→管道(管身+描边+上下管唇+左侧高光条)→鸟→地面(草沿+沙纹,按 groundOffset 滚动)→UI
- **鸟**（复刻预览图）：身体椭圆 #FFD93B 描边 #B8860B，白肚下半，翅 #F5A623（`nowMs` 驱动上下扇动，dying 时定格），眼(白底黑瞳右上)，嘴橙 #F5A623；整体按 `eng.bird.rot` 旋转
- **ready UI**：左上「最高分 ★ N」圆角徽章 + 居中大标题「FLAPPY\nBIRD」(白字描边 #2B6B72,粗体,字号≈h*0.065) + 下方「点按屏幕起飞」白底胶囊提示(呼吸闪烁 alpha 0.5+0.5*sin(nowMs/400))
- **playing/dying UI**：顶部居中大分数(白字描边,字号≈h*0.07,粗体)
- **over UI**：全屏遮罩 rgba(20,40,45,.35) → 圆角面板(≈w*0.78 宽,居中)：GAME OVER 标题、本局得分、历史最高 ★N、奖牌圆章(≥60 金/≥30 银/≥10 铜,<10 不画)、右上角奖牌挂件样式；`buttonRect` 处橙色按钮「再来一局」(圆角 12,描边)
- **fillText 描边**用 `strokeText`(lineWidth≈字号/7, stroke 后 fill)；圆角矩形手写 path（moveTo/arcTo 或 quadraticCurveTo，**bezierCurveTo 传满 6 参数或不用**）
- dark 星星：确定性伪随机（如 `frac(sin(i*127.1)*43758.5453)`），~26 颗，只画天空区
- **只用 pal 里的色值，不写死十六进制**（明暗同值项在两组 palette 里重复给出即可）

## src/theme.js（shell-dev）

`getPalette()` → 当前 pal 对象；`init(onChange)` → 读 `wx.getSystemInfoSync().theme`（undefined→light）挂初值 + `wx.onThemeChange`（try/catch）热切换并调 `onChange(pal)`。palette 结构（字段名固定，色值按本表）：

```
skyTop skyBottom star cloud
pipeBody pipeEdge pipeLip pipeHi
birdBody birdEdge birdBelly birdWing birdBeak
grass grassEdge sand sandLine
hudText hudStroke          // 大分数/标题 白字+描边
badgeBg badgeText          // 最高分徽章
hintBg hintText            // 起飞提示胶囊
mask panelBg panelEdge panelText
btnBg btnEdge btnText
medalGold medalGoldEdge medalSilver medalSilverEdge medalBronze medalBronzeEdge
```

| 字段 | light | dark |
|---|---|---|
| skyTop/skyBottom | #7ED3DE / #C9ECF2 | #101A33 / #1F2C52 |
| star | （light 不画,给 null） | #FFFFFF |
| cloud | rgba(255,255,255,.9) | rgba(255,255,255,.25) |
| pipeBody/pipeEdge/pipeLip/pipeHi | #58B94C/#3E9437/#6BC85E/rgba(255,255,255,.35) | #2F6B3F/#1F4A2C/#3D7F4F/rgba(255,255,255,.2) |
| birdBody/birdEdge/birdBelly/birdWing/birdBeak | #FFD93B/#B8860B/#FFF3C4/#F5A623/#F5A623（**明暗同值**） | 同左 |
| grass/grassEdge/sand/sandLine | #7FD35F/#5CB542/#E7DFA4/#CFC387 | #4C7A4F/#3A5F3D/#3A3427/#554C36 |
| hudText/hudStroke | #FFFFFF/#2B6B72（明暗同值） | 同左 |
| badgeBg/badgeText | rgba(255,255,255,.85)/#2B6B72 | rgba(255,255,255,.14)/#C9D6F5 |
| hintBg/hintText | rgba(255,255,255,.75)/#2B6B72 | rgba(255,255,255,.14)/#C9D6F5 |
| mask | rgba(20,40,45,.35)（明暗同值） | 同左 |
| panelBg/panelEdge/panelText | #FFF8E7/#D9C48A/#5B4A21（明暗同值） | 同左 |
| btnBg/btnEdge/btnText | #F5A623/#D18A0F/#FFFFFF（明暗同值） | 同左 |
| medal 金/银/铜 主体+描边 | #E0A62B/#8C5E14、#C0C4CE/#8A8F9C、#D08A5A/#8F5B32（明暗同值） | 同左 |

## src/store.js（shell-dev）

KEY `'flappy_best_v1'`；`getBest()→int`、`saveBest(n)`（try/catch + 内存兜底，参考 ledger/utils/store.js 模式）。

## game.json（shell-dev）

`{ "deviceOrientation": "portrait", "showStatusBar": false, "window": { "backgroundColor": "#7ED3DE" } }`

## project.config.json（shell-dev）

`compileType: "game"`，appid **`wx5b8e2f4a9c1d7e60`**（lead 分配，勿改），projectname `"Flappy Bird"`，libVersion `3.8.6`，setting `{es6:true, minified:true}`。

## src/main.js + game.js（shell-dev）

- `game.js` 仅一行 `require('./src/main.js')`
- main：读 sys → 建 canvas + ctx.scale(dpr,dpr) → theme.init(热切换 pal) → `createEngine(w,h)` → 读 best → 主循环 `canvas.requestAnimationFrame`（dt=min(t-last,50)/1000；`eng.tick(dt)`；`renderer.draw(ctx,eng,pal,w,h,Date.now())`；每帧检查 phase/score 变化：`playing→dying/over` 时 `sfx.play('hit')` + `wx.vibrateShort` + 若 score>best 则 `saveBest(score)` 并更新内存 best；`dying→over` 时 `sfx.play('die')`；score 增长时 `sfx.play('point')`）
- 触摸 `wx.onTouchStart`：ready→`eng.flap()`+`sfx.play('wing')`；playing→`eng.flap()`+`sfx.play('wing')`；dying→忽略；over 且 `Date.now()-eng.overAt>RESTART_DELAY`→`eng.reset()`+`prevScore=0`+`sfx.play('swoosh')`（整屏任意点可重开，buttonRect 只是视觉焦点）
- onThemeChange 回调里无需特殊处理（下一帧自动用新 pal 重绘）
- 首帧前先画一帧再进 rAF，避免黑屏闪烁

## src/sfx.js + sfx/*.wav（shell-dev，v1.1.0 新增）

- `sfx.init()`（require 后即调）→ 5 个 `wx.createInnerAudioContext()` 实例常驻，src 指向 `sfx/{wing,point,hit,die,swoosh}.wav`；容器缺 API 时返回 false 静默降级
- `sfx.play(name)`：**每次播放销毁旧实例、新建实例直接播**（平台特性：MediaPlayer stop/reset 后复用实例再 prepareAsync 会静默挂死，只有新建实例的首次 prepare 可靠）；单次失败只打日志，不整体降级
- 音效文件程序化生成（22050Hz/16bit/mono WAV，共 ~57KB，工程 `flappy-sfx-gen.js` 在 DSH 工作区），构建时随 icon.png 一起手动 cp 进 `main/`

## 验收（每人自测后再汇报）

- engine-dev：写完后用 `node -e` 冒烟（createEngine→循环 tick+flap 3000 帧断言无 NaN、score 递增、撞管进 dying→over；node 在 PATH）
- render-dev：node 冒烟——mock 一个最小 ctx（记录调用的方法名）跑 draw 四 phase 不断言像素,只断言不抛错、方法调用命中
- shell-dev：`node --check` 每个 js 文件语法过；game.js 一行入口
- 汇报：send_message 给 lead，列出改动文件、关键决策、偏离契约之处（如有）
