// best 分数存取：wx storage 优先（全程 try/catch），不可用时内存兜底（同会话有效）。
// key 带 appId 前缀（Dimina 沙盒按 appId 隔离，前缀防串包/便于排查）。
const APP_ID = 'wx5f8a2d7c9e1b4f30'
const KEY = APP_ID + ':roadhop_best_v1'
let memory = null // null = 尚未读过 storage

function toInt(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10)
  if (!isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function getBest() {
  if (memory !== null) return memory
  try {
    memory = toInt(wx.getStorageSync(KEY))
  } catch (e) {
    memory = 0 // 容器缺 storage → 本次会话从 0 起步
  }
  return memory
}

function saveBest(n) {
  const v = toInt(n)
  memory = Math.max(getBest(), v) // best 只增不减
  try {
    wx.setStorageSync(KEY, v)
  } catch (e) {
    /* 忽略：仅本次会话有效 */
  }
  return memory
}

export { getBest, saveBest, APP_ID, KEY }
