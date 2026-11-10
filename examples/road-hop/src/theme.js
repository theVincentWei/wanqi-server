// 主题检测（可选件，暂只记录）：3D 配色目前由 render-dev 的 palette 定，
// 这里只做系统 light/dark 检测 + wx.onThemeChange 监听（全程 try/catch，
// 容器缺 API 时静默降级为恒 light），供后续接深色调色板/雾色。
// 用法：const mode = theme.init((nextMode) => { ... });之后读 theme.getMode()。
let mode = 'light'

// 读系统主题，缺 API/缺 theme 字段 → light
function detectMode() {
  try {
    const sys = wx.getSystemInfoSync()
    if (sys && sys.theme === 'dark') return 'dark'
  } catch (e) {
    /* fallthrough */
  }
  return 'light'
}

// 挂初值 + 热切换监听。返回初始 mode；onChange(nextMode) 在系统切主题时被调。
function init(onChange) {
  mode = detectMode()
  console.log('[roadhop] theme init: ' + mode)
  try {
    wx.onThemeChange((res) => {
      const next = res && res.theme === 'dark' ? 'dark' : 'light'
      if (next === mode) return
      mode = next
      console.log('[roadhop] theme change: ' + mode) // 暂只记录
      if (typeof onChange === 'function') {
        try {
          onChange(mode)
        } catch (e) {
          /* 回调异常不影响主题记录 */
        }
      }
    })
  } catch (e) {
    /* 容器不支持主题监听 → 保持初始主题 */
  }
  return mode
}

function getMode() {
  return mode
}

export { init, getMode }
