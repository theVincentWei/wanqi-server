// 进程详情页:对齐原版 baigong h5(hero + 明细 + 杀进程)。
// 二级页:系统返回手势/返回键逐层弹,保护名单进程不提供退出按钮。
const { BASE, fmtUptime, fmtMemShort } = require('../../utils/fmt.js')
const themeUtil = require('../../utils/theme.js')

Page({
  data: {
    theme: 'light',
    state: 'loading', // loading | ok | gone | error
    errMsg: '',
    pid: 0,
    name: '',
    iconChar: '?',
    isProtected: false,
    memText: '—',
    cpuText: '—',
    memOf: '',
    // 明细行
    dPid: '—',
    dCpu: '—',
    dMem: '—',
    dElapsed: '—',
    dCommand: '—',
    killing: false,
  },

  onLoad(query) {
    this.detachTheme = themeUtil.attach(this)
    const pid = parseInt(query && query.pid, 10)
    if (!pid || pid <= 0) {
      this.setData({ state: 'error', errMsg: '缺少进程参数' })
      return
    }
    this.pid = pid
    this.setData({ pid })
    this.fetchDetail()
  },

  onUnload() {
    if (this.detachTheme) this.detachTheme()
  },

  // ── 深浅色(utils/theme.js 接线):本页无 canvas,切主题只换根 class ─────────
  applyTheme(t) {
    if (this.data.theme === t) return
    this.setData({ theme: t })
  },

  fetchDetail() {
    wx.request({
      url: BASE + '/processes/' + this.pid,
      method: 'GET',
      timeout: 10000,
      success: (res) => {
        if (res.statusCode === 404) {
          this.setData({ state: 'gone' })
          return
        }
        const d = res.statusCode === 200 ? res.data : null
        if (!d || typeof d.pid !== 'number') {
          this.setData({ state: 'gone' })
          return
        }
        const name = d.name || ('pid ' + d.pid)
        this.setData({
          state: 'ok',
          name,
          iconChar: (name.charAt(0) || '?').toUpperCase(),
          isProtected: !!d.protected,
          memText: fmtMemShort(d.memBytes),
          cpuText: typeof d.cpuPct === 'number' ? d.cpuPct.toFixed(1) + '%' : '—',
          memOf: d.memPctOfTotal != null ? '占全机内存 ' + d.memPctOfTotal.toFixed(1) + '%' : '',
          dPid: d.pid,
          dCpu: typeof d.cpuPct === 'number' ? d.cpuPct.toFixed(1) + '%' : '—',
          dMem: fmtMemShort(d.memBytes),
          dElapsed: fmtUptime(d.elapsedSec),
          dCommand: d.command || '—',
        })
      },
      fail: () => {
        this.setData({ state: 'error', errMsg: '获取进程信息失败' })
      },
    })
  },

  onKill() {
    if (this.data.killing || this.data.isProtected) return
    const name = this.data.name
    wx.showModal({
      title: '确定退出 ' + name + ' 吗?',
      content: '将强制结束该进程,未保存的内容会丢失',
      cancelText: '取消',
      confirmText: '强制退出',
      success: (r) => {
        if (r.confirm) this.doKill()
      },
    })
  },

  doKill() {
    this.setData({ killing: true })
    wx.request({
      url: BASE + '/processes/' + this.pid + '/kill',
      method: 'POST',
      timeout: 10000,
      success: (res) => {
        this.setData({ killing: false })
        if (res.statusCode !== 200) {
          const detail = res.data && res.data.detail
          const msg = detail || '退出失败,请稍后再试'
          wx.showToast({ title: msg, icon: 'none', duration: 3000 })
          if (res.statusCode === 404) this.setData({ state: 'gone' })
          return
        }
        wx.showToast({ title: '已退出该进程', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 700)
      },
      fail: () => {
        this.setData({ killing: false })
        wx.showToast({ title: '退出失败,请稍后再试', icon: 'none', duration: 3000 })
      },
    })
  },
})
