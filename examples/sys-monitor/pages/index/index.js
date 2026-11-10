// 实时概览页:对齐原版 baigong h5(三圆环/处理器与负载/内存/占用 Top 10/存储)。
// 免配置:直连本机 daemon(127.0.0.1:9207),5s 自动轮询,无刷新按钮。
const { BASE, fmtGB, fmtUptime, fmtNum, fmtPct, fmtMemShort } = require('../../utils/fmt.js')
const themeUtil = require('../../utils/theme.js')

const POLL_MS = 5000
const RING_COLORS = { cpu: '#2563EB', mem: '#F59E0B', disk: '#EF4444' }
const PROC_TOP_SHOWN = 10

Page({
  data: {
    theme: 'light',
    liveOk: false,
    liveText: '连接中…',
    // 圆环
    cpuPctText: '—', memPctText: '—', diskPctText: '—',
    memShortLine: '— / —', diskAvailShort: '余 —',
    // 处理器与负载
    cpuNow: '—', cpuUser: '—', cpuSys: '—',
    load1: '—', load5: '—', load15: '—',
    trendText: '', cores: 0,
    upText: '—',
    // 内存卡
    memUsed: '—', memAvail: '—', memComp: '—', memPctTextRow: '—',
    memPctVal: 0, warnMem: '',
    // 进程榜
    procSort: 'mem', procHasData: false, procRows: [], procState: 'loading',
    // 存储卡
    diskLine: '— 已用 · — 可用', diskPctTextHead: '—', diskPctVal: 0, warnDisk: '',
  },

  // canvas 句柄与轮询 timer 不进 data(免触发重渲染)
  rings: {},
  timer: null,
  lastPct: {},
  procAll: [],
  statsInFlight: false,
  procInFlight: false,

  onLoad() {
    this.detachTheme = themeUtil.attach(this)
  },

  onShow() {
    this.refreshStats()
    this.refreshProcs()
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.refreshStats()
        this.refreshProcs()
      }, POLL_MS)
    }
  },
  onHide() { this.stopTimer() },
  onUnload() {
    this.stopTimer()
    if (this.detachTheme) this.detachTheme()
  },
  stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  // ── 深浅色(utils/theme.js 接线):切主题重挂根 class 并按新调色板重画圆环 ──
  applyTheme(t) {
    if (this.data.theme === t) return
    this.setData({ theme: t })
    Object.keys(this.lastPct).forEach((key) => {
      if (this.rings[key]) this.drawRing(key, this.lastPct[key])
    })
  },

  onReady() { this.initRings() },

  // ── 数据腿 ────────────────────────────────────────────────────────────────
  refreshStats() {
    if (this.statsInFlight) return
    this.statsInFlight = true
    wx.request({
      url: BASE + '/stats',
      method: 'GET',
      timeout: 6000,
      success: (res) => {
        this.statsInFlight = false
        const d = res && res.statusCode === 200 ? res.data : null
        if (!d || !d.cpu || !d.mem || !d.disk) {
          this.setLive(false, '连接失败 · 自动重试中')
          return
        }
        this.setLive(true, '家端 Mac · 实时更新中')
        this.renderStats(d)
      },
      fail: () => {
        this.statsInFlight = false
        this.setLive(false, '连接失败 · 自动重试中')
      },
    })
  },

  setLive(ok, text) {
    this.setData({ liveOk: ok, liveText: text })
  },

  renderStats(d) {
    const cpu = d.cpu, mem = d.mem, disk = d.disk
    // 15 分钟负载趋势(原版语义:load15 > load5 = 正在回落,< = 上扬中)
    let trendText = ''
    if (typeof cpu.load15 === 'number' && typeof cpu.load5 === 'number') {
      if (cpu.load15 > cpu.load5) trendText = ' ↓ 正在回落'
      else if (cpu.load15 < cpu.load5) trendText = ' ↑ 上扬中'
    }
    // ≥85% 飘红警示(原版 FR-1577①):内存偏紧(可用 <200 MB 或使用率 ≥85%)
    let warnMem = ''
    if (mem.pct >= 85 || mem.availBytes < 200 * 1024 * 1024) {
      warnMem = mem.availBytes < 200 * 1024 * 1024
        ? '内存偏紧,可用不足 200 MB'
        : '内存使用率过高(≥85%)'
    }
    let warnDisk = ''
    if (disk.pct >= 85) warnDisk = '磁盘余量不足 15%,建议清理'

    this.setData({
      cpuPctText: fmtPct(cpu.pct),
      memPctText: fmtPct(mem.pct),
      diskPctText: fmtPct(disk.pct),
      memShortLine: fmtGB(mem.usedBytes) + ' / ' + fmtGB(mem.totalBytes),
      diskAvailShort: '余 ' + fmtGB(disk.availBytes),
      cpuNow: cpu.pct.toFixed(1) + '%',
      cpuUser: typeof cpu.user === 'number' ? cpu.user.toFixed(1) : '—',
      cpuSys: typeof cpu.sys === 'number' ? cpu.sys.toFixed(1) : '—',
      load1: fmtNum(cpu.load1),
      load5: fmtNum(cpu.load5),
      load15: fmtNum(cpu.load15),
      trendText,
      cores: cpu.cores || 0,
      upText: fmtUptime(d.uptimeSec),
      memUsed: fmtGB(mem.usedBytes),
      memAvail: fmtGB(mem.availBytes),
      memComp: fmtGB(mem.compressBytes),
      memPctTextRow: fmtPct(mem.pct),
      memPctVal: Math.max(0, Math.min(100, mem.pct || 0)),
      warnMem,
      diskLine: fmtGB(disk.usedBytes) + ' 已用 · ' + fmtGB(disk.availBytes) + ' 可用',
      diskPctTextHead: fmtPct(disk.pct),
      diskPctVal: Math.max(0, Math.min(100, disk.pct || 0)),
      warnDisk,
    })
    this.drawRings({ cpu: cpu.pct, mem: mem.pct, disk: disk.pct })
  },

  refreshProcs() {
    if (this.procInFlight) return
    this.procInFlight = true
    wx.request({
      url: BASE + '/processes',
      method: 'GET',
      timeout: 6000,
      success: (res) => {
        this.procInFlight = false
        const body = res && res.statusCode === 200 ? res.data : null
        if (!body || !Array.isArray(body.processes)) return // 静默:下一轮询再试
        this.procAll = body.processes
        this.renderProcRows()
      },
      fail: () => { this.procInFlight = false },
    })
  },

  renderProcRows() {
    const rows = this.procAll.slice()
    if (this.data.procSort === 'cpu') rows.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0))
    const shown = rows.slice(0, PROC_TOP_SHOWN).map((p, i) => ({
      pid: p.pid,
      rank: i + 1,
      top3: i < 3,
      name: p.name || ('pid ' + p.pid),
      cpuText: typeof p.cpuPct === 'number' ? p.cpuPct.toFixed(1) + '%' : '—',
      memText: fmtMemShort(p.memBytes),
    }))
    this.setData({ procHasData: true, procRows: shown, procState: shown.length === 0 ? 'empty' : 'ok' })
  },

  onSortMem() {
    if (this.data.procSort === 'mem') return
    this.setData({ procSort: 'mem' })
    this.renderProcRows()
  },
  onSortCpu() {
    if (this.data.procSort === 'cpu') return
    this.setData({ procSort: 'cpu' })
    this.renderProcRows()
  },

  openDetail(e) {
    const pid = e.currentTarget.dataset.pid
    if (pid) wx.navigateTo({ url: '/pages/detail/detail?pid=' + pid })
  },

  // ── 圆环(canvas 2d,原版 SVG 圆环的等价画法)────────────────────────────────
  initRings() {
    ;['cpu', 'mem', 'disk'].forEach((key) => {
      wx.createSelectorQuery()
        .select('#ring-' + key)
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res && res[0]
          if (!info || !info.node) return
          let dpr = 2
          try { dpr = wx.getSystemInfoSync().pixelRatio || 2 } catch (e) { /* 兜底 2 */ }
          const canvas = info.node
          canvas.width = Math.round(info.width * dpr)
          canvas.height = Math.round(info.height * dpr)
          const ctx = canvas.getContext('2d')
          ctx.scale(dpr, dpr)
          this.rings[key] = { ctx, w: info.width }
          if (this.lastPct[key] !== undefined) this.drawRing(key, this.lastPct[key])
        })
    })
  },

  drawRings(pctMap) {
    Object.keys(pctMap).forEach((key) => {
      this.lastPct[key] = pctMap[key]
      if (this.rings[key]) this.drawRing(key, pctMap[key])
    })
  },

  drawRing(key, pct) {
    const r = this.rings[key]
    if (!r) return
    const { ctx, w } = r
    const c = w / 2
    const strokeW = (w * 6) / 64
    const radius = c - strokeW / 2 - 0.5
    const p = Math.max(0, Math.min(100, pct || 0))
    ctx.clearRect(0, 0, w, w)
    // 轨道(深浅色随主题调色板,utils/theme.js)
    ctx.beginPath()
    ctx.arc(c, c, radius, 0, Math.PI * 2)
    ctx.strokeStyle = themeUtil.palette(this.data.theme).ringTrack
    ctx.lineWidth = strokeW
    ctx.stroke()
    // 进度弧(圆头,-90° 起;近零不画,对齐原版 dasharray 0 的行为)
    if (p >= 0.5) {
      ctx.beginPath()
      ctx.arc(c, c, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * p) / 100)
      ctx.strokeStyle = RING_COLORS[key]
      ctx.lineCap = 'round'
      ctx.stroke()
    }
  },
})
