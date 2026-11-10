// 存储封装:storage 优先,内存兜底(容器缺 wx.storage 或抛错时同会话内始终可用)。
const KEY = 'flappy_best_v1'
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
  memory = Math.max(getBest(), v) // 最高分只增不减
  try {
    wx.setStorageSync(KEY, v)
  } catch (e) {
    /* 忽略:仅本次会话有效 */
  }
  return memory
}

module.exports = { getBest, saveBest }
