const store = require('../../utils/store.js')

Page({
  data: {
    type: 'expense',
    amount: '',
    note: '',
  },
  setType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
  },
  onAmount(e) {
    this.setData({ amount: e.detail.value })
  },
  onNote(e) {
    this.setData({ note: e.detail.value })
  },
  save() {
    const amount = parseFloat(this.data.amount)
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    store.add({
      id: 't' + Date.now(),
      type: this.data.type,
      amount: Math.round(amount * 100) / 100,
      note: (this.data.note || '').trim(),
      ts: Date.now(),
    })
    wx.showToast({ title: '已记一笔', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 400)
  },
})
