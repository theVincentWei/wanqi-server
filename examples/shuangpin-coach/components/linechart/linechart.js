// linechart · canvas 2d 双曲线组件(主线蓝实线=正确率,副线橙虚线=速度)。
// 范式全照 sys-monitor/pages/history:selectorQuery 取 node → dpr 缩放物理像素 →
// ctx.scale;canvas 句柄挂 this 不进 data;主题/数据变化用最后一次数据重画;
// 空数据画占位网格线。中性色(网格/文字)与数据线颜色都取 utils/theme.js 的 palette(theme)。
const themeUtil = require('../../utils/theme.js')

// 兜底调色板:utils/theme.js 未落地或缺 palette 时的保底(色值 = SPEC §5.5 定稿)
const FALLBACK_PALETTE = {
  light: { track: '#E3E9F0', gridText: '#8B98A8', line1: '#2F6FD6', line2: '#C9803C' },
  dark: { track: '#232D3A', gridText: '#748699', line1: '#4D9DFF', line2: '#FF9D4D' },
}

Component({
  properties: {
    points: { type: Array, value: [] },    // 主线:正确率(0-100)
    points2: { type: Array, value: [] },   // 副线:速度(秒/字),可空;仅普通模式绘制
    labels: { type: Array, value: [] },    // x 轴标签(如 'MM-DD');仅普通模式绘制
    theme: { type: String, value: 'light' },
    mini: { type: Boolean, value: false }, // 迷你模式(结果页近10组):细线紧凑,无副线/标签
  },

  observers: {
    'points, points2, labels': function () { this.draw() },
    theme() { this.draw() },
    // mini 切换会改 canvas CSS 高度,须重新取 node 尺寸并重建 dpr 变换后重画
    mini() { this.initCanvas() },
  },

  lifetimes: {
    ready() {
      // canvas 常驻(wxml 无 wx:if),ready 即已挂载;properties 先于 ready 到位,
      // initCanvas 成功回调里按当前数据补画,首帧不丢
      this.initCanvas()
    },
    detached() {
      this._cv = null
    },
  },

  methods: {
    palette(theme) {
      try {
        const p = themeUtil && themeUtil.palette && themeUtil.palette(theme)
        if (p && p.track && p.line1) return p
      } catch (e) { /* utils/theme.js 未就绪时走兜底 */ }
      return FALLBACK_PALETTE[theme === 'dark' ? 'dark' : 'light']
    },

    // canvas 2d 初始化(node + dpr),sys-monitor 同款时序
    initCanvas() {
      wx.createSelectorQuery().in(this)
        .select('#cv')
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
          this._cv = { ctx, w: info.width, h: info.height }
          this.draw()
        })
    },

    draw() {
      const cv = this._cv
      if (!cv) return
      const { ctx, w, h } = cv
      const mini = !!this.data.mini
      const pal = this.palette(this.data.theme)
      const points = this.clean(this.data.points)
      const points2 = mini ? [] : this.clean(this.data.points2)
      const labels = Array.isArray(this.data.labels) ? this.data.labels : []

      // mini 紧凑边距;普通模式底部留 x 标签行
      const pad = mini ? { l: 8, r: 10, t: 8, b: 8 } : { l: 10, r: 14, t: 12, b: 20 }
      const innerW = Math.max(1, w - pad.l - pad.r)
      const innerH = Math.max(1, h - pad.t - pad.b)

      ctx.clearRect(0, 0, w, h)

      // 网格:3 条水平虚线(1/4、2/4、3/4),空数据时即整幅占位
      ctx.save()
      ctx.setLineDash([3, 4])
      ctx.lineWidth = 1
      ctx.strokeStyle = pal.track
      for (let k = 1; k <= 3; k++) {
        const y = pad.t + (innerH * k) / 4
        ctx.beginPath()
        ctx.moveTo(pad.l, y)
        ctx.lineTo(pad.l + innerW, y)
        ctx.stroke()
      }
      ctx.restore()

      if (!points.length) return // 空数据:只画占位网格线

      // x 标签画在 canvas 上,与数据点精确对位(HTML flex 会错位)
      if (!mini) this.drawXLabels(labels, points.length, pad, innerW, h, pal.gridText)

      // 主线:蓝实线 + 末端圆点(mockup 同款)
      this.strokeSeries(points, {
        color: pal.line1,
        width: mini ? 1.5 : 2,
        dot: true,
        dotR: mini ? 2.5 : 3.5,
        pad, innerW, innerH,
      })
      // 副线:橙虚线,无圆点
      if (points2.length) {
        this.strokeSeries(points2, {
          color: pal.line2,
          width: mini ? 1.5 : 2,
          dash: [5, 4],
          dot: false,
          pad, innerW, innerH,
        })
      }
    },

    // 数组清洗:仅留有限数字
    clean(arr) {
      if (!Array.isArray(arr)) return []
      return arr.map(Number).filter((n) => isFinite(n))
    },

    // 一条曲线:各自量纲归一化(正确率 % 与速度 秒/字 量纲不同,不能共轴),
    // 贝塞尔平滑(sys-monitor smoothPath 同式,禁折线直角)
    strokeSeries(values, opts) {
      const { ctx } = this._cv
      const { pad, innerW, innerH } = opts
      const n = values.length
      const rng = this.normRange(values)
      const pts = values.map((v, i) => ({
        x: this.xAt(i, n, pad.l, innerW),
        y: pad.t + (1 - (v - rng.lo) / (rng.hi - rng.lo)) * innerH,
      }))

      ctx.save()
      if (opts.dash) ctx.setLineDash(opts.dash)
      ctx.lineWidth = opts.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = opts.color
      if (n > 1) {
        const ops = this.smoothPath(pts)
        ctx.beginPath()
        ops.forEach((op) => {
          if (op[0] === 'moveTo') ctx.moveTo(op[1], op[2])
          else ctx.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6])
        })
        ctx.stroke()
      }
      // 末端圆点(mockup:正确率线尾点)
      if (opts.dot) {
        const last = pts[pts.length - 1]
        ctx.beginPath()
        ctx.arc(last.x, last.y, opts.dotR, 0, Math.PI * 2)
        ctx.fillStyle = opts.color
        ctx.fill()
      }
      ctx.restore()
    },

    // 归一化域:上下各留 15% 空隙;数值全平(无跨度)时给 ±1 假跨度避免除零
    normRange(values) {
      let min = Math.min.apply(null, values)
      let max = Math.max.apply(null, values)
      if (max - min < 1e-9) { min -= 1; max += 1 }
      const gap = (max - min) * 0.15
      return { lo: min - gap, hi: max + gap }
    },

    xAt(i, n, padL, innerW) {
      return n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1)
    },

    // x 标签:等距取 ≤5 个,首尾贴边对齐,画在对应数据点的精确 x 上
    drawXLabels(labels, n, pad, innerW, h, color) {
      if (!labels.length) return
      const { ctx } = this._cv
      const k = Math.min(5, n)
      ctx.save()
      ctx.font = '9px sans-serif'
      ctx.fillStyle = color
      if (k === 1) {
        ctx.textAlign = 'left'
        ctx.fillText(String(labels[0] || ''), pad.l, h - 6)
      } else {
        for (let i = 0; i < k; i++) {
          const idx = Math.round((i * (n - 1)) / (k - 1))
          const x = this.xAt(idx, n, pad.l, innerW)
          ctx.textAlign = i === 0 ? 'left' : (i === k - 1 ? 'right' : 'center')
          ctx.fillText(String(labels[idx] || ''), x, h - 6)
        }
      }
      ctx.restore()
    },

    // 贝塞尔平滑(sys-monitor/pages/history 同式)
    smoothPath(pts) {
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
  },
})
