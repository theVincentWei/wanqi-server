// 统计 Tab(SPEC §6.6):三卡 + 近14天双曲线 + 薄弱韵母专练 + 生词本 M2 占位 + 新用户空态。
// 数据全走 utils/store.js(getOverview/getFinalStats);主题走 utils/theme.js
// (sys-monitor v6 范式:onLoad attach / onUnload detach,applyTheme 只 setData,
//  linechart 以 theme 属性接收变化自行重画)。onShow 刷新,练完一组切回来即更新。
const store = require('../../utils/store.js')
const themeUtil = require('../../utils/theme.js')

Page({
  data: {
    theme: 'light',
    hasData: false,   // 新用户空态开关:totalGroups === 0 即整页空态
    totalChars: '0',  // 千分位字符串,如 '1,240'
    totalGroups: 0,
    streakText: '0 天',
    acc14: [],        // 近14天正确率(0-100),linechart 主线
    sec14: [],        // 近14天均速(秒/字),linechart 副线
    dates: [],        // 近14天日期 'MM-DD',x 标签
    weak: [],         // 前6薄弱韵母 [{fin, accText, barW, tone}]
  },

  onLoad() {
    this.detachTheme = themeUtil.attach(this)
  },
  onShow() {
    // Tab 常驻页:每次切回都刷新(结果页「查看统计」直达时数据已落 store)
    this.refresh()
  },
  onUnload() {
    if (this.detachTheme) this.detachTheme()
  },

  // ── 深浅色(utils/theme.js 接线):换根 class;linechart 观察 theme 属性自重画 ──
  applyTheme(t) {
    if (this.data.theme === t) return
    this.setData({ theme: t })
  },

  refresh() {
    let ov = {}
    let finStats = []
    try { ov = store.getOverview() || {} } catch (e) { /* storage 异常按空数据渲染 */ }
    try { finStats = store.getFinalStats() || [] } catch (e) { /* 同上 */ }

    const days = Array.isArray(ov.days) ? ov.days : []
    const totalGroups = ov.totalGroups || 0
    // 条形 tone:acc<80 红(--err)、<85 橙(--hot)、其余蓝(--acc)(SPEC §6.6)
    const weak = (Array.isArray(finStats) ? finStats : [])
      .slice(0, 6)
      .map((s) => {
        const acc = Math.round(Number(s.acc) || 0)
        return {
          fin: s.fin,
          accText: acc + '%',
          barW: Math.max(4, Math.min(100, acc)) + '%', // 低分条形保底可见 4%
          tone: acc < 80 ? 'err' : (acc < 85 ? 'hot' : 'acc'),
        }
      })

    this.setData({
      hasData: totalGroups > 0,
      totalChars: this.fmtNum(ov.totalChars),
      totalGroups,
      streakText: (ov.streakDays || 0) + ' 天',
      acc14: days.map((d) => Number(d.acc) || 0),
      sec14: days.map((d) => Number(d.avgSec) || 0),
      dates: days.map((d) => d.date),
      weak,
    })
  },

  // 薄弱韵母「专练」:直开一组 20 题看拼(SPEC §6.6 契约参数,不得改)
  onDrill(e) {
    const fin = e.currentTarget.dataset.fin
    if (!fin) return
    wx.navigateTo({
      url: '/pages/practice/practice?finals=' + encodeURIComponent(fin) +
        '&mode=look&input=builtin&hint=0&count=20',
    })
  },

  // 空态按钮:切到练习 Tab
  goPractice() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  // 12345 → '12,345'(mockup 三卡千分位)
  fmtNum(n) {
    const v = Math.round(Number(n) || 0)
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  },
})
