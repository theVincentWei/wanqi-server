// 使用记录:直连 /api/monitor/token-usage/activity(coding key 鉴权)。
//   GET ...?startTime=yyyy-MM-dd HH:mm:ss&endTime=... (URL 编码空格)
//   data: { granularity, timezone,
//     summary: { totalTokens, peakDailyTokens, peakDailyTokensDate,
//                totalUsageDurationMs, currentStreakDays, longestStreakDays },
//     series: [ { date, totalTokens, mcpCalls } ] }   // 按天粒度
// 当日视图取「昨日→今日」一次调用同时拿两天;近7日/近30日按范围取。
// Cache 命中率/低峰占比/按模型拆分在 usage-detail,需 Bigmodel-Organization 组织头,
// key 拿不到组织 id → 页面标「待接入」。
// 当日的 5h 窗口小卡复用 quota/limit。
const BASE = 'https://open.bigmodel.cn/api/monitor/token-usage/activity'
const QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const KEY_STORAGE = 'glm_quota_key'
const AUTO_STORAGE = 'glm_quota_autorefresh'

function fmtDt(d) {
  const p = (x) => (x < 10 ? '0' + x : '' + x)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function fmtTok(x) {
  const n = Number(x) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'K'
  return String(n)
}
function fmtDur(ms) {
  const h = Math.floor(ms / 3.6e6)
  const m = Math.round((ms % 3.6e6) / 6e4)
  if (h >= 1) return h + ' 小时' + (m ? m + ' 分' : '')
  return m + ' 分钟'
}
function fmtAbs(ms) {
  if (!ms) return '—'
  const n = Number(ms)
  const d = new Date(n > 1e12 ? n : n * 1000)
  const p = (x) => (x < 10 ? '0' + x : '' + x)
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

Page({
  data: {
    period: 'week', // day | week | month
    hasKey: false,
    loading: false,
    error: '',
    cards: [],
    chart: { showLabels: false, items: [], labels: [] },
    window5h: null,
    updatedAtText: '',
  },
  onShow() {
    let saved = ''
    try { saved = wx.getStorageSync(KEY_STORAGE) || '' } catch (e) { /* 忽略 */ }
    let auto = true
    try {
      const v = wx.getStorageSync(AUTO_STORAGE)
      auto = (v === '' || v == null) ? true : !!v
    } catch (e) { /* 忽略 */ }
    this._key = saved
    this._auto = auto
    this._ticks = 0
    clearInterval(this._timer)
    this.setData({ hasKey: !!saved })
    if (saved) this.load()
    this._timer = setInterval(() => this.tick(), 30000)
  },
  onHide() { clearInterval(this._timer) },
  onUnload() { clearInterval(this._timer) },
  goConfig() {
    try { wx.switchTab({ url: '/pages/config/config', fail: () => {} }) } catch (e) { /* 忽略 */ }
  },
  tick() {
    this._ticks += 1
    if (this._ticks % 2 === 0 && this._key && this._auto) this.load(true) // 每 60s 静默刷新
  },
  onSeg(e) {
    const p = e.currentTarget.dataset.period
    if (!p || p === this.data.period) return
    this.setData({ period: p })
    if (this._key) this.load()
  },
  range(period) {
    const now = new Date()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
    let start = new Date(end)
    if (period === 'day') start.setDate(end.getDate() - 1)       // 昨日→今日
    else if (period === 'week') start.setDate(end.getDate() - 6)  // 近7日
    else start.setDate(end.getDate() - 29)                        // 近30日
    return { start, end }
  },
  load(silent) {
    const key = this._key
    if (!key) {
      this.setData({ error: '先在「配置」页填入 coding key' })
      return
    }
    this.setData({ loading: !silent, error: '' })
    const r = this.range(this.data.period)
    const url = BASE + '?startTime=' + encodeURIComponent(fmtDt(r.start)) +
      '&endTime=' + encodeURIComponent(fmtDt(r.end))
    wx.request({
      url,
      method: 'GET',
      header: { Authorization: key },
      success: (res) => {
        if (res.statusCode === 401 || res.statusCode === 403 ||
            (res.data && res.data.code === 1000)) {
          this.setData({ loading: false, error: 'key 无效或无权限,去「配置」页重新粘贴' })
          return
        }
        if (res.statusCode !== 200 || !res.data || res.data.success !== true) {
          const msg = (res.data && res.data.msg) || ('HTTP ' + res.statusCode)
          this.setData({ loading: false, error: '查询失败: ' + msg })
          return
        }
        this.applyActivity(res.data.data || {})
        if (this.data.period === 'day') this.loadWindow(key)
      },
      fail: (err) => {
        this.setData({ loading: false, error: '请求失败: ' + (err.errMsg || 'network') })
      },
    })
  },
  applyActivity(data) {
    const series = data.series || []
    const sum = data.summary || {}
    const period = this.data.period
    let cards = []
    let chart = { showLabels: false, items: [], labels: [] }
    if (period === 'day') {
      const today = series.length ? series[series.length - 1] : { totalTokens: 0 }
      const yest = series.length > 1 ? series[0] : { totalTokens: 0 }
      let delta = ''
      if (yest.totalTokens > 0) {
        const d = Math.round((today.totalTokens - yest.totalTokens) / yest.totalTokens * 100)
        delta = (d >= 0 ? '▲' : '▼') + Math.abs(d) + '% vs 昨日'
      }
      cards = [
        { v: fmtTok(today.totalTokens), l: '今日 Tokens', delta, blue: true },
        { v: fmtTok(yest.totalTokens), l: '昨日 Tokens' },
        { v: (sum.currentStreakDays || 0) + ' 天', l: '连续使用' },
        { v: fmtDur(sum.totalUsageDurationMs || 0), l: '范围使用时长' },
      ]
    } else {
      const days = series.length || 1
      const total = sum.totalTokens != null ? sum.totalTokens
        : series.reduce((a, s) => a + (Number(s.totalTokens) || 0), 0)
      const avg = total / days
      cards = [
        { v: fmtTok(total), l: 'Tokens 总数', blue: true },
        { v: fmtTok(avg), l: '日均 Tokens' },
        { v: fmtTok(sum.peakDailyTokens || 0), l: '峰值 · ' + (sum.peakDailyTokensDate || '').slice(5) },
        { v: (sum.currentStreakDays || 0) + ' / ' + (sum.longestStreakDays || 0) + ' 天', l: '连续 / 最长连续' },
      ]
      const max = Math.max.apply(null, series.map((s) => Number(s.totalTokens) || 0)) || 1
      const items = series.map((s) => ({
        date: (s.date || '').slice(5),
        v: fmtTok(s.totalTokens),
        h: Math.max(2, Math.round((Number(s.totalTokens) || 0) / max * 100)),
        peak: s.date === sum.peakDailyTokensDate,
      }))
      const n = items.length
      let labels = items.map(() => '')
      const marks = period === 'week' ? items.map((_, i) => i) : [0, Math.round(n / 3), Math.round(2 * n / 3), n - 1]
      marks.forEach((i) => { labels[i] = items[i] ? items[i].date : '' })
      chart = {
        showLabels: period === 'week',
        items,
        labels: labels.map((t, k) => ({ k, t })),
      }
    }
    this.setData({
      loading: false,
      cards,
      chart,
      updatedAtText: '更新于 ' + fmtAbs(Date.now()) + (this._auto ? ' · 每 60 秒自动刷新' : ''),
    })
  },
  loadWindow(key) {
    // 当日视图的 5h 窗口小卡(静默,失败即隐藏)
    wx.request({
      url: QUOTA_URL,
      method: 'GET',
      header: { Authorization: key },
      success: (res) => {
        const limits = (res.data && res.data.data && res.data.data.limits) || []
        let tokens = null
        let tools = null
        for (let i = 0; i < limits.length; i++) {
          if (limits[i].type === 'TOKENS_LIMIT') tokens = limits[i]
          else if (limits[i].type === 'TIME_LIMIT') tools = limits[i]
        }
        if (!tokens) { this.setData({ window5h: null }); return }
        const pct = Math.max(0, Math.min(100, Number(tokens.percentage) || 0))
        this.setData({
          window5h: {
            pctText: Math.round(pct) + '%',
            pct,
            resetText: fmtAbs(tokens.nextResetTime),
            toolsText: tools && tools.remaining != null
              ? '剩 ' + tools.remaining + '/' + tools.usage + ' 次工具额度' : '',
          },
        })
      },
      fail: () => { this.setData({ window5h: null }) },
    })
  },
})
