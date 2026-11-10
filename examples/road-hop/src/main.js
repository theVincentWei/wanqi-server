// road-hop 壳层入口（ESM 源码，经 esbuild 打成 CJS bundle 后由 game.js require）。
// 壳层只做编排：系统信息/canvas → renderer（分辨率铁律在 renderer 内部执行）
// → engine → 触摸（点按=跳一格、左右滑=变道一格）→ rAF 主循环 → 死亡存 best。
// 纯逻辑在 engine.js（engine-dev），three 场景/绘制在 renderer.js（render-dev）。
//
// ==== 对 src/engine.js（engine-dev）的接口期望（并行开发中，按此调用侧对接）====
//   createEngine({ cols }) -> eng
//     eng.phase : 'ready' | 'playing' | 'dead'   // 壳层只依赖这三个值
//     eng.score : number                        // 已到达的最大行数
//     eng.best  : number                        // 壳层注入并同步，renderer 直接读
//     eng.tap()          // 点按：向前跳一格（120ms 补间由 engine 内部处理）
//     eng.swipe(dir)     // dir=-1 左移一格 / dir=+1 右移一格
//     eng.tick(dt)       // 推进 dt 秒：车流、跳跃补间、AABB 碰撞、乌鸦超时判定
//     eng.reset()        // 死亡后重开
//
// ==== 对 src/renderer.js（render-dev）的接口期望（并行开发中，按此调用侧对接）====
//   createRenderer({ canvas, cssW, cssH, pixelRatio, themeMode }) -> view
//     内部必须执行「分辨率铁律」（CONTRACT.md，v1.0.9 黑屏教训）：
//       禁止手动预设 canvas.width/height；
//       new THREE.WebGLRenderer({ canvas, antialias: true }) 之后：
//       dpr = Math.min(pixelRatio || 2, 3, 4096 / Math.max(cssW, cssH))
//       renderer.setPixelRatio(dpr); renderer.setSize(cssW, cssH, false)
//     view.render(eng, nowMs)     // 每帧：eng 状态 → three 场景同步 + renderer.render
//     view.setThemeMode(mode)     // 可选钩子：'light'|'dark'，壳层已 try/catch 保护
//     view.renderer               // 可选：暴露底层 THREE.WebGLRenderer 便于调试
import { createEngine } from './engine.js'
import { createRenderer } from './renderer.js'
import * as store from './store.js'
import * as theme from './theme.js'

const TAG = '[roadhop]'
const DEAD_RESTART_DELAY = 600 // 死亡后多少 ms 才接受点按重开，防误触连跳

function fatal(msg) {
  console.error(TAG + ' FATAL:', msg)
  try { wx.showToast({ title: String(msg).slice(0, 24), icon: 'none' }) } catch (_) {}
}

// wx.onTouch* 逐个注册，缺 API 只降级不崩
function reg(name, cb) {
  try { wx[name](cb) } catch (e) { console.error(TAG + ' ' + name + ' unavailable:', e) }
}

function main() {
  // ---- 系统信息：css 尺寸 + pixelRatio ----
  let info = {}
  try { info = wx.getSystemInfoSync() || {} } catch (e) { console.error(TAG + ' getSystemInfoSync:', e) }
  const cssW = info.windowWidth > 0 ? Math.floor(info.windowWidth) : 390
  const cssH = info.windowHeight > 0 ? Math.floor(info.windowHeight) : 844
  const pixelRatio = info.pixelRatio > 0 ? info.pixelRatio : 2

  // ---- 画布。绝不手动设 canvas.width/height（分辨率铁律，位图全权交给 three） ----
  let canvas = null
  try { canvas = wx.createCanvas() } catch (e) { console.error(TAG + ' createCanvas:', e) }
  if (!canvas) { fatal('canvas 不可用'); return }

  // ---- 主题（暂只记录；支持 renderer 的 setThemeMode 可选钩子） ----
  let view = null
  const themeMode = theme.init((mode) => {
    console.log(TAG + ' theme -> ' + mode)
    try {
      if (view && typeof view.setThemeMode === 'function') view.setThemeMode(mode)
    } catch (_) { /* 主题钩子异常不影响游戏 */ }
  })

  // ---- 渲染器（render-dev）：分辨率铁律在其内部执行 ----
  try {
    view = createRenderer({ canvas, cssW, cssH, pixelRatio, themeMode })
  } catch (e) { fatal('renderer 初始化失败: ' + (e && e.message)); return }

  // ---- 引擎（engine-dev） ----
  let eng = null
  try { eng = createEngine({ cols: 9 }) } catch (e) { fatal('engine 初始化失败: ' + (e && e.message)); return }

  // ---- best：storage（try/catch + 内存兜底）→ 注入 engine，renderer 直接读 eng.best ----
  let best = store.getBest()
  eng.best = best

  // ---- 死亡时刻（rAF 时间戳口径），用于重开防误触 ----
  let deadAt = 0

  // ---- 触摸：只取起止两点判「点按 vs 左右滑」，不监听 Move ----
  const SWIPE_MIN = Math.max(24, Math.round(cssW * 0.08)) // css px
  let from = null
  reg('onTouchStart', (e) => {
    const t = e && e.changedTouches && e.changedTouches[0]
    if (t) from = { x: t.clientX, y: t.clientY }
  })
  reg('onTouchEnd', (e) => {
    const t = e && e.changedTouches && e.changedTouches[0]
    const start = from
    from = null
    if (!t || !start) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    try {
      if (eng.phase === 'dead') {
        if (Date.now() - deadAt > DEAD_RESTART_DELAY) { eng.reset(); deadAt = 0 }
        return
      }
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) eng.swipe(dx > 0 ? 1 : -1)
      else eng.tap()
    } catch (err) { console.error(TAG + ' input:', err) }
  })
  reg('onTouchCancel', () => { from = null })

  // ---- 死亡边沿：震动 + best 持久化（store 内部自带 try/catch + 内存兜底） ----
  // deadAt 用 Date.now()（与 onTouchEnd 里的重开判定同一时钟，防 rAF ts 口径不一致）
  let prevPhase = eng.phase
  function checkPhase() {
    if (prevPhase !== 'dead' && eng.phase === 'dead') {
      deadAt = Date.now()
      try { wx.vibrateShort({ type: 'heavy' }) } catch (_) { /* 容器可能缺震动 API */ }
      if (eng.score > best) {
        best = store.saveBest(eng.score)
        eng.best = best // 同步给 renderer（HUD/结算）
      }
    }
    prevPhase = eng.phase
  }

  // ---- 主循环：rAF 挂在 canvas 上（渲染层 vsync，时间戳单调）；dt 钳 50ms；
  //      单帧异常只丢帧不杀循环（flappy 配方），致命错误才走 fatal ----
  let last = -1
  function frame(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) ts = Date.now()
    if (last < 0 || ts < last) last = ts
    const dt = Math.min(ts - last, 50) / 1000
    last = ts
    try {
      eng.tick(dt)
      checkPhase()
      view.render(eng, ts)
    } catch (e) {
      console.error(TAG + ' frame:', e && (e.stack || e.message))
    }
    canvas.requestAnimationFrame(frame)
  }

  // ---- 首帧先渲染一次再进 rAF，避免黑屏闪烁 ----
  try { view.render(eng, 0) } catch (e) { console.error(TAG + ' first frame:', e && (e.stack || e.message)) }
  canvas.requestAnimationFrame(frame)
  console.log(TAG + ' start ' + cssW + 'x' + cssH + ' pr=' + pixelRatio + ' best=' + best)
}

try { main() } catch (e) { fatal(e && (e.stack || e.message)) }
