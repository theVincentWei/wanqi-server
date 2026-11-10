// kbboard · 小鹤双拼虚拟键盘（SPEC §6.1）
// 三行 QWERTY + 末行 ⌫；每键 = 字母行(固定高) + 标注区(固定高、顶部对齐)。
// 对齐铁律（SPEC §3）：不允许整体垂直居中导致字母随标注行数上下漂移——
// 字母行 44rpx 固定，标注区 45rpx（3 行 × 15rpx）固定，全部 padding-top 起排。
// KEY_LABELS 按 SPEC §5.3 内置（与 data/flypy.json 一致），不运行时读文件。
const KEY_LABELS = {
  q: ['iu'], w: ['ei'], e: ['e'], r: ['uan', 'er'], t: ['ue', 'üe'],
  y: ['un', 'ün'], u: ['u', 'sh'], i: ['i', 'ch'], o: ['o', 'uo'], p: ['ie'],
  a: ['a'], s: ['ong', 'iong'], d: ['ai'], f: ['en'], g: ['eng'], h: ['ang'],
  j: ['an'], k: ['ing', 'uai'], l: ['iang', 'uang'],
  z: ['ou'], x: ['ia', 'ua'], c: ['ao'], v: ['ui', 'ü', 'zh'], b: ['in'],
  n: ['iao'], m: ['ian'],
}

const ROW_KEYS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'del'],
]

function buildRows() {
  return ROW_KEYS.map((keys, ri) => ({
    name: 'row' + ri,
    keys: keys.map((k) => ({
      k,
      up: k === 'del' ? '⌫' : k.toUpperCase(),
      labels: KEY_LABELS[k] || [],
    })),
  }))
}

Component({
  properties: {
    // 标注淡显（提示关闭时小字 opacity .32）
    dim: { type: Boolean, value: false },
    // 目标键高亮，逗号分隔，如 "u,l"
    highlight: {
      type: String,
      value: '',
      observer(v) {
        const map = {}
        String(v || '').split(',').forEach((s) => {
          const t = String(s || '').trim().toLowerCase()
          if (t) map[t] = true
        })
        this.setData({ hlMap: map })
      },
    },
  },

  data: {
    rows: [],
    hlMap: {},
  },

  lifetimes: {
    attached() {
      this.setData({ rows: buildRows() })
    },
  },

  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key
      // 震动反馈：API 不存在/被系统禁用/频率受限都吞掉，绝不影响判分
      try {
        if (typeof wx !== 'undefined' && typeof wx.vibrateShort === 'function') {
          wx.vibrateShort({ type: 'light' })
        }
      } catch (err) { /* ignore */ }
      if (key === 'del') {
        this.triggerEvent('del')
      } else {
        this.triggerEvent('key', { key })
      }
    },
  },
})
