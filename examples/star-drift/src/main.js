// star-drift 壳层入口（ESM 源码，经 esbuild 打成 CJS bundle 后由 game.js require）。
// 壳层只做编排：系统信息/canvas → renderer（分辨率铁律在 renderer 内部执行）
// → engine → 触摸（拖拽增量=横向机动、点按=开局/重开）→ rAF 主循环 → 死亡存 best。
// 纯逻辑在 engine.js（engine-dev），three 场景/绘制/HUD 在 renderer.js（render-dev）。
//
// ==== 对 src/engine.js（engine-dev）的接口期望（并行开发中，按此调用侧对接）====
//   createEngine({ halfRange }) -> eng     // halfRange=4：横向 ±4 世界单位（契约）
//     eng.phase       : 'ready' | 'playing' | 'dead'   // 壳层只依赖这三个值
//     eng.score       : number             // 距离(米) + 晶体×50
//     eng.best        : number             // 壳层注入并同步，renderer 直接读
//     eng.deathReason : string             // 死因，如 'asteroid'（MVP 唯一）
//     eng.drag(dx)    // 拖拽增量 dx（css px）：映射横向目标位，平滑 lerp 由 engine 内部处理
//     eng.tap()       // 点按：ready→开局；playing 内暂无语义（无跳/蓄力），engine 自决
//     eng.tick(dt)    // 推进 dt 秒：前进、小行星/晶体生成推进、球体碰撞
//     eng.reset()     // 死亡后重开
//
// ==== 对 src/renderer.js（render-dev）的接口期望（并行开发中，按此调用侧对接）====
//   createRenderer({ canvas, cssW, cssH, pixelRatio, themeMode }) -> view
//     内部必须执行「分辨率铁律」（road-hop/three-bench 已验证）：禁止手动预设
//       canvas.width/height；new THREE.WebGLRenderer({ canvas, antialias: true }) 后
//       dpr = Math.min(pixelRatio || 2, 3, 4096 / Math.max(cssW, cssH))
//       renderer.setPixelRatio(dpr); renderer.setSize(cssW, cssH, false)
//     3A 观感归 renderer：IBL（scene.environment = equirect 贴图，three 自动 PMREM）、
//       ACESFilmicToneMapping + 曝光、emissive 辉光（禁 bloom/EffectComposer 多 pass）；
//       设备降级退路 = Hemisphere + 2 Directional 三点光
//     view.render(eng, nowMs)     // 每帧：eng 状态 → three 场景同步 + renderer.render
//     view.setThemeMode(mode)     // 可选钩子：'light'|'dark'，壳层已 try/catch 保护
//     view.renderer               // 可选：暴露底层 THREE.WebGLRenderer 便于调试
//     HUD：第二块 wx.createCanvas() 画 2D → CanvasTexture 贴回主 canvas；拿不到降级无 HUD 不崩
import { createEngine } from './engine.js'
import { createRenderer } from './renderer.js'
import * as store from './store.js'

const TAG = '[stardrift]'
const DEAD_RESTART_DELAY = 600 // 死亡后多少 ms 才接受点按重开，防误触
const TAP_SLOP = 12            // 起止位移 ≤ 该值(css px)判点按，否则整段手势算拖拽

function fatal(msg) {
  console.error(TAG + ' FATAL:', msg)
  try { wx.showToast({ title: String(msg).slice(0, 24), icon: 'none' }) } catch (_) {}
}

// wx.onTouch* 逐个注册，缺 API 只降级不崩
function reg(name, cb) {
  try { wx[name](cb) } catch (e) { console.error(TAG + ' ' + name + ' unavailable:', e) }
}

function main() {
  // ---- 系统信息：css 尺寸 + pixelRatio（顺带取系统主题初值） ----
  let info = {}
  try { info = wx.getSystemInfoSync() || {} } catch (e) { console.error(TAG + ' getSystemInfoSync:', e) }
  const cssW = info.windowWidth > 0 ? Math.floor(info.windowWidth) : 390
  const cssH = info.windowHeight > 0 ? Math.floor(info.windowHeight) : 844
  const pixelRatio = info.pixelRatio > 0 ? info.pixelRatio : 2

  // ---- 画布。绝不手动设 canvas.width/height（分辨率铁律，位图全权交给 three） ----
  let canvas = null
  try { canvas = wx.createCanvas() } catch (e) { console.error(TAG + ' createCanvas:', e) }
  if (!canvas) { fatal('canvas 不可用'); return }

  // ---- 主题（内联检测；暂只记录，支持 renderer 的 setThemeMode 可选钩子） ----
  let view = null
  let themeMode = info && info.theme === 'dark' ? 'dark' : 'light'
  console.log(TAG + ' theme init: ' + themeMode)
  try {
    wx.onThemeChange((res) => {
      themeMode = res && res.theme === 'dark' ? 'dark' : 'light'
      console.log(TAG + ' theme -> ' + themeMode)
      try {
        if (view && typeof view.setThemeMode === 'function') view.setThemeMode(themeMode)
      } catch (_) { /* 主题钩子异常不影响游戏 */ }
    })
  } catch (_) { /* 容器不支持主题监听 → 保持初值 */ }

  // ---- 渲染器（render-dev）：分辨率铁律 + 3A 观感（IBL/ACES）在其内部执行 ----
  try {
    view = createRenderer({ canvas, cssW, cssH, pixelRatio, themeMode })
  } catch (e) { fatal('renderer 初始化失败: ' + (e && e.message)); return }

  // ---- 引擎（engine-dev）：halfRange=4（横向 ±4 世界单位，契约） ----
  let eng = null
  try { eng = createEngine({ halfRange: 4 }) } catch (e) { fatal('engine 初始化失败: ' + (e && e.message)); return }

  // ---- best：storage（try/catch + 内存兜底）→ 注入 engine，renderer 直接读 eng.best ----
  let best = store.getBest()
  eng.best = best

  // ---- 死亡时刻（Date.now 口径），用于重开防误触 ----
  let deadAt = 0

  // ---- 触摸：Move 上报拖拽增量，End 上按「整段位移」区分点按 vs 拖拽 ----
  let tracking = false
  let startX = 0, startY = 0, lastX = 0
  reg('onTouchStart', (e) => {
    const t = e && e.changedTouches && e.changedTouches[0]
    if (!t) return
    tracking = true
    startX = lastX = t.clientX
    startY = t.clientY
  })
  reg('onTouchMove', (e) => {
    if (!tracking) return
    const t = e && e.changedTouches && e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - lastX
    lastX = t.clientX
    if (eng.phase === 'dead') return // 死亡期拖拽不累计，避免重开后目标位漂移
    try { eng.drag(dx) } catch (err) { console.error(TAG + ' drag:', err) }
  })
  reg('onTouchEnd', (e) => {
    tracking = false
    const t = e && e.changedTouches && e.changedTouches[0]
    if (!t) return
    const moved = Math.abs(t.clientX - startX) + Math.abs(t.clientY - startY)
    try {
      if (eng.phase === 'dead') {
        if (Date.now() - deadAt > DEAD_RESTART_DELAY) { eng.reset(); deadAt = 0 }
        return
      }
      if (moved <= TAP_SLOP) eng.tap() // ready→开局；playing 内点按语义 engine 自决
    } catch (err) { console.error(TAG + ' input:', err) }
  })
  reg('onTouchCancel', () => { tracking = false })

  // ---- 死亡边沿：震动 + best 持久化（store 内部自带 try/catch + 内存兜底） ----
  // deadAt 用 Date.now()（与 onTouchEnd 里的重开判定同一时钟，防 rAF ts 口径不一致）
  let prevPhase = eng.phase
  function checkPhase() {
    if (prevPhase !== 'dead' && eng.phase === 'dead') {
      deadAt = Date.now()
      try { wx.vibrateShort({ type: 'heavy' }) } catch (_) { /* 容器可能缺震动 API */ }
      console.error(TAG + ' dead: ' + (eng.deathReason || 'unknown') + ' score=' + eng.score)
      if (eng.score > best) {
        best = store.saveBest(eng.score)
        eng.best = best // 同步给 renderer（HUD/结算）
      }
    }
    prevPhase = eng.phase
  }

  // ---- 主循环：rAF 挂在 canvas 上（渲染层 vsync，时间戳单调）；dt 钳 50ms；
  //      单帧异常只丢帧不杀循环（road-hop 配方），致命错误才走 fatal ----
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
