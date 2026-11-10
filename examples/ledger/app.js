// 记账本 Demo — AppHub 小程序开发样例(配合 dsh-go 小程序开发 Skill)。
// 数据存 wx.storage,键 ledger_txs_v1;首次启动播种样例数据。
App({
  onLaunch() {
    try {
      const saved = wx.getStorageSync('ledger_txs_v1')
      if (saved && saved.length) return
    } catch (e) { /* storage 不可用时走内存兜底 */ }
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    const seed = [
      { id: 's1', type: 'expense', amount: 28.5, note: '午餐·牛肉面', ts: now - day },
      { id: 's2', type: 'expense', amount: 15, note: '地铁', ts: now - day },
      { id: 's3', type: 'income', amount: 12800, note: '工资', ts: now - 3 * day },
      { id: 's4', type: 'expense', amount: 2399, note: '机械键盘', ts: now - 5 * day },
    ]
    try { wx.setStorageSync('ledger_txs_v1', seed) } catch (e) { /* 忽略 */ }
  },
})
