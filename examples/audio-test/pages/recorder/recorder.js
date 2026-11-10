const { pushLog, pushEvent } = require('../../utils/log')

Page({
  data: {
    format: 'aac',
    recording: false,
    stateText: '空闲',
    result: null,
    logs: [],
  },

  onLoad() {
    // 单例：与播放页共享同一个 RecorderManager
    const mgr = wx.getRecorderManager()
    mgr.onStart(() => {
      this.setData({ recording: true, stateText: '录音中(上限 10s)' })
      pushEvent(this, 'onStart', {}, 'info')
    })
    mgr.onPause(() => {
      this.setData({ stateText: '已暂停' })
      pushEvent(this, 'onPause', {})
    })
    mgr.onResume(() => {
      this.setData({ stateText: '继续录音' })
      pushEvent(this, 'onResume(无此事件,仅操作回显)', {}, 'info')
    })
    mgr.onStop((payload) => {
      this.setData({
        recording: false,
        stateText: '空闲',
        result: {
          tempFilePath: payload && payload.tempFilePath,
          duration: payload && payload.duration,
          fileSize: payload && payload.fileSize,
        },
      })
      pushEvent(this, 'onStop', payload, 'info')
    })
    mgr.onError((payload) => {
      const errMsg = payload && payload.errMsg
      const isAuthDeny = errMsg && errMsg.indexOf('auth deny') !== -1
      this.setData({ recording: false, stateText: isAuthDeny ? '权限被拒' : '出错' })
      pushEvent(this, 'onError' + (isAuthDeny ? '(auth deny 分支 ✓)' : ''), payload, 'error')
    })
    mgr.onInterruptionBegin(() => pushEvent(this, 'onInterruptionBegin', {}, 'error'))
    mgr.onInterruptionEnd(() => pushEvent(this, 'onInterruptionEnd', {}, 'info'))
    this.manager = mgr
    pushLog(this, '[操作] getRecorderManager() 并注册 6 事件', 'info')
  },

  onUnload() {
    if (this.player) this.player.destroy()
  },

  formatTapped(e) {
    const format = e.currentTarget.dataset.format
    this.setData({ format })
    pushLog(this, '[操作] 切换录音格式 → ' + format, 'info')
  },

  startTapped() {
    const options = {
      duration: 10000,
      sampleRate: 44100,
      numberOfChannels: 1,
      format: this.data.format,
    }
    if (this.data.format === 'aac') options.encodeBitRate = 96000
    pushLog(this, '[操作] start(' + JSON.stringify(options) + ')')
    this.manager.start(options)
  },

  pauseTapped() {
    pushLog(this, '[操作] pause()')
    this.manager.pause()
  },

  resumeTapped() {
    pushLog(this, '[操作] resume()')
    this.manager.resume()
  },

  stopTapped() {
    pushLog(this, '[操作] stop()')
    this.manager.stop()
  },

  // 非法格式：契约 JS 侧校验，直接 onError invalid format，不下发原生
  invalidFormatTapped() {
    pushLog(this, '[操作] start({format:"mp3"}) —— 预期 onError invalid format', 'info')
    this.manager.start({ format: 'mp3' })
  },

  resetTapped() {
    pushLog(this, '[操作] 返回播放页再进可观察单例跨页保持(日志重建,实例不变)', 'info')
  },

  playResultTapped() {
    if (!this.data.result || !this.data.result.tempFilePath) return
    if (this.player) this.player.destroy()
    const ctx = wx.createInnerAudioContext()
    ctx.onError((payload) => pushEvent(this, '[回放] onError', payload, 'error'))
    ctx.onEnded(() => pushEvent(this, '[回放] onEnded', {}, 'info'))
    ctx.onCanplay(() => pushEvent(this, '[回放] onCanplay', {}, 'info'))
    ctx.src = this.data.result.tempFilePath
    this.player = ctx
    pushLog(this, '[操作] 回放 src=' + this.data.result.tempFilePath, 'info')
    ctx.play()
  },

  stopPlayResultTapped() {
    if (this.player) {
      pushLog(this, '[操作] 停止回放 stop()')
      this.player.stop()
    }
  },

  clearLogs() {
    this.setData({ logs: [] })
  },

  goBack() {
    wx.navigateBack()
  },
})
