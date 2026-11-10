// GLM 用量(前端直连 bigmodel 监控接口,无后端):
// GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
//   Header: Authorization: <coding key>(裸 key 或 Bearer 都认,接口不接受查询参数)
//   响应 data: { level, limits: [{ type, unit, number, usage, currentValue, remaining,
//     percentage, nextResetTime(ms), usageDetails: [{modelCode, usage}] }] }
//   实测(2026-11): TIME_LIMIT = 工具调用额度,unit=5(月) number=1,随订阅续期重置;
//                 TOKENS_LIMIT = token 窗口,unit=3(小时) number=5,即 5 小时窗口。
//   usage=总量,currentValue=已用,remaining=剩余;usageDetails 仅 TIME_LIMIT 有。
// GET https://open.bigmodel.cn/api/paas/v4/models → 模型目录(Bearer)。
// key 与自动刷新开关存于「配置」tab 的 wx storage:glm_quota_key / glm_quota_autorefresh。
const QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const MODELS_URL = 'https://open.bigmodel.cn/api/paas/v4/models'
const KEY_STORAGE = 'glm_quota_key'
const AUTO_STORAGE = 'glm_quota_autorefresh'
const UNIT_TEXT = { 1: '秒', 2: '分钟', 3: '小时', 4: '天', 5: '个月', 6: '周' }
const TYPE_TEXT = { TIME_LIMIT: '工具调用额度', TOKENS_LIMIT: 'Token 窗口' }

Page({
  data: {
    hasKey: false,
    loading: false,
    error: '',
    tokens: null,
    tools: null,
    models: [],
    modelsNote: '',
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
    this._raw = null
    this._ticks = 0
    clearInterval(this._timer)
    this.setData({ hasKey: !!saved })
    if (saved) {
      this.refresh()
      this.loadModels()
    }
    this._timer = setInterval(() => this.tick(), 30000)
  },
  onHide() { clearInterval(this._timer) },
  onUnload() { clearInterval(this._timer) },
  goConfig() {
    try { wx.switchTab({ url: '/pages/config/config', fail: () => {} }) } catch (e) { /* 忽略 */ }
  },
  tick() {
    this._ticks += 1
    if (this._raw) this.applyQuota(this._raw) // 重算倒计时文案
    if (this._ticks % 2 === 0 && this._key && this._auto) this.refresh(true) // 每 60s 静默刷新
  },
  refresh(silent) {
    const key = this._key
    if (!key) {
      this.setData({ error: '先在「配置」页填入 coding key' })
      return
    }
    this.setData({ loading: !silent, error: '' })
    wx.request({
      url: QUOTA_URL,
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
        this._raw = (res.data.data && res.data.data.limits) || []
        this.applyQuota(this._raw, res.data.data)
      },
      fail: (err) => {
        this.setData({ loading: false, error: '请求失败: ' + (err.errMsg || 'network') })
      },
    })
  },
  applyQuota(limits, extra) {
    let tokens = null
    let tools = null
    for (let i = 0; i < limits.length; i++) {
      const it = limits[i]
      const pct = Math.max(0, Math.min(100, Number(it.percentage) || 0))
      const common = {
        title: TYPE_TEXT[it.type] || it.type,
        windowText: this.windowText(it),
        pctText: it.percentage == null ? '—' : Math.round(it.percentage) + '%',
        pct,
        hot: pct >= 90 ? 'danger' : (pct >= 70 ? 'warn' : ''),
        cdText: this.fmtCd(it.nextResetTime),
        resetText: this.fmtAbs(it.nextResetTime),
      }
      if (it.type === 'TOKENS_LIMIT') {
        tokens = common
      } else if (it.type === 'TIME_LIMIT') {
        const total = Number(it.usage) || 0
        const used = it.currentValue != null ? Number(it.currentValue)
          : Math.max(0, total - (Number(it.remaining) || 0))
        const remaining = it.remaining != null ? Number(it.remaining) : Math.max(0, total - used)
        const details = (it.usageDetails || []).map((d) => ({
          code: d.modelCode || '-',
          usage: d.usage == null ? 0 : Number(d.usage),
          sharePct: used > 0 ? Math.round((Number(d.usage) || 0) / used * 100) : 0,
        }))
        tools = Object.assign(common, {
          hasNums: total > 0,
          total,
          used,
          remaining,
          details,
        })
      }
    }
    const level = extra && extra.level != null ? String(extra.level) : ''
    this.setData({
      loading: false,
      tokens,
      tools,
      levelText: level ? level.charAt(0).toUpperCase() + level.slice(1) : '',
      updatedAtText: '更新于 ' + this.fmtAbs(Date.now()) + (this._auto ? ' · 每 60 秒自动刷新' : ''),
    })
  },
  loadModels() {
    wx.request({
      url: MODELS_URL,
      method: 'GET',
      header: { Authorization: 'Bearer ' + this._key },
      success: (res) => {
        const list = (res.data && res.data.data) || []
        const models = list.map((m) => ({ id: m.id }))
        this.setData({ models, modelsNote: models.length + ' 个可用' })
      },
      fail: () => { this.setData({ models: [], modelsNote: '' }) },
    })
  },
  windowText(it) {
    const u = UNIT_TEXT[it.unit]
    if (!u) return TYPE_TEXT[it.type] || it.type
    return (it.number == null ? '' : it.number + ' ') + u
  },
  fmtCd(ms) {
    if (!ms) return '—'
    const left = Number(ms) - Date.now()
    if (left <= 0) return '已到重置点,稍候刷新'
    const m = Math.floor(left / 60000)
    if (m < 1) return '不到 1 分钟后重置'
    const d = Math.floor(m / 1440)
    const h = Math.floor((m % 1440) / 60)
    const mm = m % 60
    if (d > 0) return d + ' 天 ' + h + ' 小时后重置'
    if (h > 0) return h + ' 小时 ' + mm + ' 分后重置'
    return mm + ' 分钟后重置'
  },
  fmtAbs(ms) {
    if (!ms) return '—'
    const n = Number(ms)
    const d = new Date(n > 1e12 ? n : n * 1000)
    const p = (x) => (x < 10 ? '0' + x : '' + x)
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  },
})
