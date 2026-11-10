// 近 24 小时页:对齐原版 baigong h5(图例 + SVG 平滑曲线 + 今日摘要)。
// 曲线用 canvas 2d 画:贝塞尔平滑 + 线下渐变 + 0/25/50/75/100% 网格,禁折线直角。
const { BASE, fmtDelta, hhmm } = require('../../utils/fmt.js')
const themeUtil = require('../../utils/theme.js')

const SERIES = [
  { key: 'cpuPct', color: '#2563EB' },
  { key: 'memPct', color: '#F59E0B' },
  { key: 'diskPct', color: '#EF4444' },
]

Page({
  data: {
    theme: 'light',
    hasPoints: false,
    xticks: [],
    sumCpu: '—',
    sumMem: '—',
    sumDisk: '—',
  },

  chart: null, // { ctx, w, h },canvas 就绪后注入;不进 data
  points: [],
  chartInFlight: false,

  onLoad() {
    this.detachTheme = themeUtil.attach(this)
  },
  onReady() {
    // canvas 在 wx:if={{hasPoints}} 里,首进本页时多半还没挂载;真正的初始化
    // 在 loadHistory 的 setData 回调里做(setData 回调 = DOM 已挂载)
    if (this.data.hasPoints) this.initChart()
  },
  onShow() { this.loadHistory() },
  onHide() { /* 无轮询 */ },
  onUnload() {
    if (this.detachTheme) this.detachTheme()
  },

  // ── 深浅色(utils/theme.js 接线):切主题重挂根 class 并按新调色板重画曲线 ──
  applyTheme(t) {
    if (this.data.theme === t) return
    this.setData({ theme: t })
    if (this.chart && this.points.length) this.renderChart(this.points)
  },

  initChart() {
    wx.createSelectorQuery()
      .select('#chart')
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
        this.chart = { ctx, w: info.width, h: info.height }
        if (this.points.length) this.renderChart(this.points)
      })
  },

  loadHistory() {
    if (this.chartInFlight) return
    this.chartInFlight = true
    wx.request({
      url: BASE + '/history',
      method: 'GET',
      timeout: 15000,
      success: (res) => {
        this.chartInFlight = false
        const body = res && res.statusCode === 200 ? res.data : null
        if (!body) return
        const points = Array.isArray(body.points) ? body.points : []
        this.points = points
        this.setData({ hasPoints: points.length > 0 }, () => {
          // setData 回调里 canvas 必已挂载:没初始化过就初始化(成功后自带补画),
          // 已就绪就直接画,两种时序都不丢帧
          if (!this.chart) this.initChart()
          else if (points.length) this.renderChart(points)
        })
        if (body.summary) this.renderSummary(body.summary)
      },
      fail: () => { this.chartInFlight = false },
    })
  },

  // ── SVG 平滑曲线的 canvas 等价画法(原版 smoothPath 同式)────────────────────
  smoothPath(pts) {
    if (pts.length === 0) return null
    const ops = []
    ops.push(['moveTo', pts[0].x, pts[0].y])
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[Math.min(pts.length - 1, i + 2)]
      ops.push([
        'bezierCurveTo',
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y,
      ])
    }
    return ops
  },

  strokeOps(ops) {
    const ctx = this.chart.ctx
    ctx.beginPath()
    ops.forEach((op) => {
      if (op[0] === 'moveTo') ctx.moveTo(op[1], op[2])
      else ctx.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6])
    })
    ctx.stroke()
  },

  renderChart(points) {
    const cv = this.chart
    if (!cv) return
    const { ctx, w } = cv
    const height = 200
    const padL = 8
    const padR = 34 // 右侧 100%/75%/50%/25% 标签位
    const padT = 10
    const padB = 8
    const innerW = w - padL - padR
    const innerH = height - padT - padB

    const tMin = points[0].t
    let tMax = points[points.length - 1].t
    if (tMax === tMin) tMax = tMin + 1
    const toX = (t) => padL + ((t - tMin) / (tMax - tMin)) * innerW
    const toY = (pct) => padT + (1 - Math.max(0, Math.min(100, pct)) / 100) * innerH

    ctx.clearRect(0, 0, w, height)

    // 0/25/50/75/100% 网格 + 右侧标签
    ctx.lineWidth = 1
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'right'
    for (let gv = 0; gv <= 100; gv += 25) {
      const y = toY(gv)
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + innerW, y)
      ctx.strokeStyle = 'rgba(127,127,127,0.14)'
      ctx.stroke()
      if (gv > 0) {
        ctx.fillStyle = themeUtil.palette(this.data.theme).gridText
        ctx.fillText(gv + '%', w - 2, y + 3)
      }
    }

    // 三条平滑曲线 + 线下渐变(颜色 = 定稿三色)
    SERIES.forEach((s) => {
      const pts = points.map((p) => ({ x: toX(p.t), y: toY(p[s.key]) }))
      const ops = this.smoothPath(pts)
      if (!ops) return
      const base = padT + innerH
      // 线下渐变填充
      const grad = ctx.createLinearGradient(0, padT, 0, base)
      grad.addColorStop(0, this.rgba(s.color, 0.26))
      grad.addColorStop(1, this.rgba(s.color, 0.02))
      ctx.beginPath()
      ops.forEach((op) => {
        if (op[0] === 'moveTo') ctx.moveTo(op[1], op[2])
        else ctx.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6])
      })
      ctx.lineTo(pts[pts.length - 1].x, base)
      ctx.lineTo(pts[0].x, base)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()
      // 曲线本体
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = s.color
      this.strokeOps(ops)
    })

    // 时间轴:首点 HH:MM → 现在,五等分刻度
    const ticks = []
    for (let k = 0; k < 4; k++) ticks.push(hhmm(tMin + ((tMax - tMin) * k) / 4))
    ticks.push('现在')
    this.setData({ xticks: ticks })
  },

  // #RRGGBB + alpha → rgba(...),渐变色需要
  rgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
  },

  renderSummary(summary) {
    this.setData({
      sumCpu: Math.round(summary.cpuAvg || 0) + '% / ' + Math.round(summary.cpuPeak || 0) + '%',
      sumMem: Math.round(summary.memAvg || 0) + '% / ' + Math.round(summary.memPeak || 0) + '%',
      sumDisk: Math.round(summary.diskPctNow || 0) + '% / ' + fmtDelta(summary.diskDeltaBytes),
    })
  },
})
