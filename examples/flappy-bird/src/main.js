// 主入口:canvas+dpr → theme → engine → 主循环(dt≤50ms) → 触摸分发 → 死亡震动+最高分。
// 壳层只做编排;纯逻辑在 engine,纯绘制在 renderer(均为契约接口)。
const theme = require('./theme')
const store = require('./store')
const sfx = require('./sfx')
const { PHYS } = require('./constants') // engine-dev,契约导出
const { createEngine } = require('./engine') // engine-dev,契约导出
const renderer = require('./renderer') // render-dev,契约导出 draw/buttonRect

sfx.init() // 音效预加载:缺 API 时静默降级,游戏逻辑零感知

const RESTART_DELAY = PHYS.RESTART_DELAY

// ---- 画布与尺寸:逻辑坐标 = css px,物理像素 = ×dpr ----
let w = 375
let h = 667
let dpr = 1
try {
  const sys = wx.getSystemInfoSync()
  if (sys && sys.windowWidth > 0) w = sys.windowWidth
  if (sys && sys.windowHeight > 0) h = sys.windowHeight
  const pr = sys && sys.pixelRatio > 0 ? sys.pixelRatio : 1
  dpr = Math.min(pr, 3) // 契约:高 dpr 钳到 3
} catch (e) {
  /* 容器缺 systemInfo → 用兜底尺寸 */
}

let canvas = null
let ctx = null
try {
  canvas = wx.createCanvas()
  ctx = canvas.getContext('2d')
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.scale(dpr, dpr)
} catch (e) {
  console.log('[flappy] canvas init failed: ' + e)
  throw e // 无 canvas 游戏无法运行,明确失败优于黑屏
}
if (!canvas || !ctx) throw new Error('[flappy] canvas unavailable')

// ---- 主题与引擎 ----
let pal = theme.init((next) => {
  pal = next // 热切换:下一帧 draw 自动用新 pal
})
const eng = createEngine(w, h)
let best = store.getBest()
eng.best = best // renderer 读 eng.best 画徽章/结算面板（契约补位字段）

// ---- phase/score 变化:死亡(hit/die)+得分(point)音效、震动+存最高分 ----
let prevPhase = eng.phase
let prevScore = 0
function onDeath() {
  try {
    wx.vibrateShort({ type: 'heavy' })
  } catch (e) {
    /* 容器可能缺震动 API */
  }
  if (eng.score > best) {
    best = eng.score
    store.saveBest(best) // store 内部自带 try/catch + 内存兜底
    eng.best = best // 同步给 renderer
  }
}

function checkPhase() {
  if (prevPhase === 'playing' && (eng.phase === 'dying' || eng.phase === 'over')) {
    sfx.play('hit') // 撞击瞬间(撞管/撞地同声;直接撞地无 dying,只有 hit)
    onDeath()
  }
  if (prevPhase === 'dying' && eng.phase === 'over') {
    sfx.play('die') // 撞管后坠落触地的「摔落」音
  }
  if (eng.score > prevScore) {
    prevScore = eng.score
    sfx.play('point')
  }
  prevPhase = eng.phase
}

// ---- 主循环:dt 上限 50ms;单帧异常只丢帧,不杀循环 ----
let last = null
function frame(t) {
  if (typeof t !== 'number' || !isFinite(t)) t = Date.now()
  if (last === null || t < last) last = t
  const dt = Math.min(t - last, 50) / 1000
  last = t
  try {
    eng.tick(dt)
    checkPhase()
    renderer.draw(ctx, eng, pal, w, h, Date.now())
  } catch (e) {
    console.log('[flappy] frame error: ' + e)
  }
  canvas.requestAnimationFrame(frame)
}

// ---- 触摸分发:ready/playing→flap;dying→忽略;over→过 RESTART_DELAY 整屏可重开 ----
function onTouch(e) {
  try {
    const t = e && e.changedTouches && e.changedTouches[0]
    if (!t) return
    if (eng.phase === 'ready' || eng.phase === 'playing') {
      eng.flap()
      sfx.play('wing')
    } else if (eng.phase === 'over') {
      if (Date.now() - eng.overAt > RESTART_DELAY) {
        eng.reset()
        prevScore = 0 // 分数归零同步,避免下局 checkPhase 得分音误判
        sfx.play('swoosh') // 重开「唰」过场音
      }
    }
  } catch (err) {
    console.log('[flappy] touch error: ' + err)
  }
}

try {
  wx.onTouchStart(onTouch)
} catch (e) {
  console.log('[flappy] onTouchStart unavailable: ' + e)
}

// ---- 首帧先画一帧再进 rAF,避免黑屏闪烁 ----
try {
  renderer.draw(ctx, eng, pal, w, h, Date.now())
} catch (e) {
  console.log('[flappy] first frame error: ' + e)
}
canvas.requestAnimationFrame(frame)
