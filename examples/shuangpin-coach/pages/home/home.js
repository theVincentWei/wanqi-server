// 配置首页（练习 Tab）· SPEC §6.2 + mockup S1
const theme = require('../../utils/theme.js')

// 兜底存储访问：store.js 由 sp-core 并行提供，任何异常都不能让配置页白屏
let store = null
try { store = require('../../utils/store.js') } catch (e) { store = null }

// 全部韵母，按「易→难」排布（与 mockup S1 chips 顺序一致，33 个）
const FINALS_ALL = [
  'a', 'o', 'e', 'i', 'u', 'ü',
  'ai', 'ei', 'ui', 'ao', 'ou', 'iu', 'ie', 'üe', 'er',
  'an', 'en', 'in', 'un', 'ün',
  'ang', 'eng', 'ing', 'ong',
  'ia', 'ua', 'iao', 'uai', 'ian', 'iang', 'uang', 'iong', 'uan',
]

// 「推荐 易→难」默认组：mockup S1 拍板稿中勾选的默认集
const RECOMMENDED = ['a', 'i', 'u', 'ai', 'ou', 'ang', 'eng', 'ing', 'ong', 'iang', 'uang']

const DEFAULT_CFG = { finals: [], mode: 'look', input: 'builtin', hint: false, count: 20 }

function loadCfgSafe() {
  try {
    const c = store && store.loadCfg ? store.loadCfg() : null
    return Object.assign({}, DEFAULT_CFG, c || {})
  } catch (e) {
    return Object.assign({}, DEFAULT_CFG)
  }
}

function saveCfgSafe(cfg) {
  try { if (store && store.saveCfg) store.saveCfg(cfg) } catch (e) { /* storage 兜底 */ }
}

function getOverviewSafe() {
  try { return (store && store.getOverview ? store.getOverview() : null) || null } catch (e) { return null }
}

function getFinalStatsSafe() {
  try { return (store && store.getFinalStats ? store.getFinalStats() : []) || [] } catch (e) { return [] }
}

Page({
  data: {
    theme: 'light',
    finList: [],      // [{fin, on}]
    finOn: 0,
    weakFins: [],     // 我的薄弱 前4
    mode: 'look',     // look | listen(M3 置灰)
    input: 'builtin', // builtin | system
    hint: false,
    count: 20,
    subText: '小鹤双拼 · 从一组开始练起',
  },

  onLoad() {
    try { this.detachTheme = theme.attach(this) } catch (e) { this.setData({ theme: 'light' }) }
    this.cfg = loadCfgSafe()
    this.applyCfg()
    this.refreshWeak()
    this.refreshSub()
    // 音频能力探测（v7.0）：新容器离线可播；旧容器听音需连主机，warn 行才显示
    let natAudio = false
    try { natAudio = typeof wx.createInnerAudioContext === 'function' } catch (e) { natAudio = false }
    this.setData({ natAudio })
  },

  onUnload() {
    try { this.detachTheme && this.detachTheme() } catch (e) { /* ignore */ }
  },

  onShow() {
    this.refreshWeak()
    this.refreshSub()
  },

  applyTheme(t) {
    this.setData({ theme: t })
  },

  applyCfg() {
    const cfg = this.cfg
    const sel = {}
    ;(cfg.finals || []).forEach((f) => { sel[f] = true })
    const finList = FINALS_ALL.map((f) => ({ fin: f, on: !!sel[f] }))
    this.setData({
      finList,
      finOn: finList.filter((x) => x.on).length,
      mode: cfg.mode || 'look',
      input: cfg.input || 'builtin',
      hint: !!cfg.hint,
      count: cfg.count || 20,
    })
  },

  refreshWeak() {
    const stats = getFinalStatsSafe()
    const valid = {}
    FINALS_ALL.forEach((f) => { valid[f] = true })
    const weakFins = stats
      .map((s) => s.fin)
      .filter((f) => valid[f])
      .slice(0, 4)
    this.weakFins = weakFins
    this.setData({ weakN: weakFins.length })
  },

  refreshSub() {
    const o = getOverviewSafe()
    const g = o && o.totalGroups ? o.totalGroups : 0
    const d = o && o.streakDays ? o.streakDays : 0
    const subText = g > 0
      ? `小鹤双拼 · 已练 ${g} 组 · 连续 ${d} 天 🔥`
      : '小鹤双拼 · 从一组开始练起'
    this.setData({ subText })
  },

  persist() {
    saveCfgSafe(this.cfg)
  },

  toggleFin(e) {
    const fin = e.currentTarget.dataset.fin
    const finals = (this.cfg.finals || []).slice()
    const i = finals.indexOf(fin)
    if (i >= 0) finals.splice(i, 1)
    else finals.push(fin)
    this.cfg.finals = finals
    this.persist()
    this.applyCfg()
  },

  selectAll() {
    this.cfg.finals = FINALS_ALL.slice()
    this.persist()
    this.applyCfg()
  },

  clearAll() {
    this.cfg.finals = []
    this.persist()
    this.applyCfg()
  },

  pickRecommended() {
    this.cfg.finals = RECOMMENDED.slice()
    this.persist()
    this.applyCfg()
  },

  pickWeak() {
    const w = this.weakFins || []
    if (!w.length) return
    this.cfg.finals = w.slice()
    this.persist()
    this.applyCfg()
  },

  tapWordSeg() {
    wx.showToast({ title: '词语模式 M2 上线', icon: 'none' })
  },

  setMode(e) {
    const v = e.currentTarget.dataset.v
    if (v !== 'look' && v !== 'listen') return
    this.cfg.mode = v
    this.persist()
    this.setData({ mode: v })
  },

  setInput(e) {
    const v = e.currentTarget.dataset.v
    if (v !== 'builtin' && v !== 'system') return
    this.cfg.input = v
    this.persist()
    this.setData({ input: v })
  },

  setCount(e) {
    const n = parseInt(e.currentTarget.dataset.v, 10)
    if (n !== 10 && n !== 20 && n !== 30) return
    this.cfg.count = n
    this.persist()
    this.setData({ count: n })
  },

  setHint(e) {
    const v = !!(e.currentTarget.dataset.v === 'on')
    this.cfg.hint = v
    this.persist()
    this.setData({ hint: v })
  },

  onStart() {
    const valid = {}
    FINALS_ALL.forEach((f) => { valid[f] = true })
    const finals = (this.cfg.finals || []).filter((f) => valid[f])
    if (!finals.length) {
      wx.showToast({ title: '先选要练的韵母', icon: 'none' })
      return
    }
    // 按全表顺序输出，URL 稳定
    const ordered = FINALS_ALL.filter((f) => finals.indexOf(f) >= 0)
    this.cfg.finals = ordered
    this.persist()
    const url = '/pages/practice/practice?finals=' + encodeURIComponent(ordered.join(','))
      + '&mode=' + (this.cfg.mode || 'look')
      + '&input=' + (this.cfg.input || 'builtin')
      + '&hint=' + (this.cfg.hint ? '1' : '0')
      + '&count=' + (this.cfg.count || 20)
    wx.navigateTo({ url })
  },
})
