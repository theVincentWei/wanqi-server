// 配置页:GLM coding key(存本机沙盒)+ 自动刷新开关 + 数据来源说明。
// key 供「用量」「记录」两页直连 bigmodel 监控接口使用。
const KEY_STORAGE = 'glm_quota_key'
const AUTO_STORAGE = 'glm_quota_autorefresh'

Page({
  data: {
    keyInput: '',
    hasKey: false,
    auto: true,
  },
  onShow() {
    let saved = ''
    try { saved = wx.getStorageSync(KEY_STORAGE) || '' } catch (e) { /* 忽略 */ }
    let auto = true
    try {
      const v = wx.getStorageSync(AUTO_STORAGE)
      auto = (v === '' || v == null) ? true : !!v
    } catch (e) { /* 忽略 */ }
    this.setData({ keyInput: saved, hasKey: !!saved, auto })
  },
  onKeyInput(e) {
    this.setData({ keyInput: e.detail.value })
  },
  onAutoChange(e) {
    const on = !!(e.detail && e.detail.value)
    try { wx.setStorageSync(AUTO_STORAGE, on) } catch (err) { /* 忽略 */ }
    this.setData({ auto: on })
    wx.showToast({ title: on ? '已开启自动刷新' : '已关闭自动刷新', icon: 'none' })
  },
  clearKey() {
    try { wx.removeStorageSync(KEY_STORAGE) } catch (e) { /* 忽略 */ }
    this.setData({ keyInput: '', hasKey: false })
    wx.showToast({ title: '已清除', icon: 'none' })
  },
  saveKey() {
    const key = (this.data.keyInput || '').trim()
    if (!key) {
      wx.showToast({ title: '请先粘贴 key', icon: 'none' })
      return
    }
    try { wx.setStorageSync(KEY_STORAGE, key) } catch (e) { /* 忽略 */ }
    this.setData({ hasKey: true })
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => {
      try { wx.switchTab({ url: '/pages/index/index', fail: () => {} }) } catch (e) { /* 忽略 */ }
    }, 800)
  },
})
