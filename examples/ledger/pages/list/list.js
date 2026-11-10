const store = require('../../utils/store.js')

Page({
  data: {
    entries: [],
    incomeText: '0.00',
    expenseText: '0.00',
    balanceText: '0.00',
  },
  onShow() {
    const entries = store.all()
    const s = store.summary(entries)
    this.setData({
      entries,
      incomeText: s.income.toFixed(2),
      expenseText: s.expense.toFixed(2),
      balanceText: s.balance.toFixed(2),
    })
  },
  goAdd() {
    wx.navigateTo({ url: '/pages/add/add' })
  },
})
