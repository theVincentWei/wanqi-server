// 结果页（全屏）· SPEC §6.4 + mockup S5
// 圆环正确率（CSS conic-gradient）+ 用时/均速/最快/错题 + 近10组迷你曲线 + 错题列表
// 再来一组(redirectTo practice 同参数) + 查看统计(wx.switchTab)
const theme = require('../../utils/theme.js')

let store = null
try { store = require('../../utils/store.js') } catch (e) { store = null }

function getSessionSafe(id) {
  try { return (store && store.getSession ? store.getSession(id) : null) || null } catch (e) { return null }
}

function getSessionsSafe(n) {
  try { return (store && store.getSessions ? store.getSessions(n) : []) || [] } catch (e) { return [] }
}

function getOverviewSafe() {
  try { return (store && store.getOverview ? store.getOverview() : null) || null } catch (e) { return null }
}

function upper(s) { return String(s || '').toUpperCase() }

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return Math.floor(s / 60) + '′' + String(s % 60).padStart(2, '0') + '″'
}

// 错题行：头行「shuāng · 应为 UL」，小行「你打 UD ← uang 应打 L」（内置键盘才有键序纠错）
function decorateWrong(p) {
  const w = {
    char: p.char || '',
    py: p.py0 || '',
    keysUp: upper(p.keys),
    typedUp: upper(p.typed),
    tail: '',
    keyPart: '',
  }
  const t = String(p.typed || '').toLowerCase()
  const keys = String(p.keys || '').toLowerCase()
  if (/^[a-z]{1,2}$/.test(t) && /^[a-z]{2}$/.test(keys)) {
    if (t.charAt(0) !== keys.charAt(0)) {
      w.tail = p.ini ? ('声母 ' + p.ini) : '声母'
      w.keyPart = upper(keys.charAt(0))
    } else {
      w.tail = p.fin ? ('韵母 ' + p.fin) : '韵母'
      w.keyPart = upper(keys.charAt(1))
    }
  }
  return w
}

Page({
  data: {
    theme: 'light',
    ord: 1,
    rsub: '',
    accPct: 0,
    durText: "0′00″",
    avgText: '--',
    fastText: '--',
    wrongCount: 0,
    wrongs: [],
    points: [],
    labels: [],
    trendLnk: '',
    canRetry: false,
  },

  onLoad(options) {
    try { this.detachTheme = theme.attach(this) } catch (e) { this.setData({ theme: 'light' }) }
    this.id = options.id || ''
    this.load()
  },

  onUnload() {
    try { this.detachTheme && this.detachTheme() } catch (e) { /* ignore */ }
  },

  applyTheme(t) {
    this.setData({ theme: t })
  },

  load() {
    let s = getSessionSafe(this.id)
    if (!s) {
      // id 丢失（存储兜底失败）时回退最近一条
      const last = getSessionsSafe(1)
      s = last[0] || null
    }
    if (!s) {
      s = { mode: 'look', finals: [], input: 'builtin', count: 0, correct: 0, durationMs: 0, per: [], ts: Date.now() }
    }
    this.session = s

    const per = s.per || []
    const count = s.count || per.length || 0
    const correct = s.correct != null ? s.correct : per.filter((p) => p.ok).length
    const accPct = count ? Math.round((correct * 100) / count) : 0
    const durMs = s.durationMs || 0
    const wrongs = per.filter((p) => !p.ok).map((p, i) => Object.assign({ idx: i }, decorateWrong(p)))

    let fastest = null
    per.forEach((p) => {
      if (p && typeof p.ms === 'number' && (!fastest || p.ms < fastest.ms)) fastest = p
    })
    const fastText = fastest
      ? fastest.char + ' ' + (fastest.py0 || '') + ' · ' + (fastest.ms / 1000).toFixed(1) + '″'
      : '--'

    const o = getOverviewSafe()
    const ord = (o && o.totalGroups) || 1

    // 近 10 组正确率（升序，最后一点=本次）
    const recent = getSessionsSafe(10).slice().reverse()
    const points = recent.map((x) => {
      const c = x.count || (x.per ? x.per.length : 0)
      const cr = x.correct != null ? x.correct : 0
      return c ? Math.round((cr * 100) / c) : 0
    })
    const trendLnk = points.length >= 2
      ? points[0] + '% → ' + points[points.length - 1] + '%'
      : ''

    const finals = (s.finals || []).join(' ')
    const modeTxt = s.mode === 'listen' ? '听音' : '看拼'
    const inputTxt = s.input === 'system' ? '系统键盘' : '内置键盘'
    const rsub = ['单字', finals, modeTxt, inputTxt].filter(Boolean).join(' · ')

    this.setData({
      ord,
      rsub,
      accPct,
      durText: fmtDur(durMs),
      avgText: count ? (durMs / 1000 / count).toFixed(1) + '″ / 字' : '--',
      fastText,
      wrongCount: per.length ? per.length - correct : (count ? count - correct : 0),
      wrongs,
      points,
      trendLnk,
      canRetry: !!(s.finals && s.finals.length),
    })
  },

  onRetry() {
    const s = this.session || {}
    const finals = (s.finals || []).join(',')
    if (!finals) return
    const url = '/pages/practice/practice?finals=' + encodeURIComponent(finals)
      + '&mode=' + (s.mode || 'look')
      + '&input=' + (s.input || 'builtin')
      + '&hint=0'
      + '&count=' + (s.count || 20)
    wx.redirectTo({ url })
  },

  onStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },
})
