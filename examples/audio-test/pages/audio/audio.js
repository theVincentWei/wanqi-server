const { pushLog, pushEvent } = require('../../utils/log')

// 包内曲目：dmcc 编译后手动 cp 进 main/assets（编译器资产收编只认图片扩展名）。
// 网络曲目：真机 cleartext 只放行 127.0.0.1/localhost，必须走 AppHub 网关反代。
const APP_ID = 'wx3a7f2c9e1b8d4f56'
const SOURCES = {
  bundle: 'assets/bundle-melody.wav',
  net: 'http://127.0.0.1:7610/api/v1/apps/' + APP_ID + '/audio/net-echo.wav',
}

const EVENTS = [
  'Canplay', 'Play', 'Pause', 'Stop', 'Ended', 'TimeUpdate',
  'Error', 'Waiting', 'Seeking', 'Seeked', 'Loadedmetadata',
]

Page({
  data: {
    source: 'bundle',
    srcText: SOURCES.bundle,
    rate: 1,
    volume: 80,
    loop: false,
    durationText: '0.0',
    currentTimeText: '0.0',
    pausedText: 'true',
    logs: [],
  },

  onLoad() {
    this.createAudio()
    this.startPolling()
  },

  onUnload() {
    this.stopPolling()
    if (this.audio) this.audio.destroy()
  },

  createAudio() {
    const ctx = wx.createInnerAudioContext()
    EVENTS.forEach((name) => {
      ctx['on' + name]((payload) => {
        if (name === 'Error') {
          pushEvent(this, 'onError', payload, 'error')
        }
        else if (name === 'TimeUpdate') {
          // timeUpdate 高频事件只刷状态行，不进日志面板
          if (payload && typeof payload.currentTime === 'number') {
            this.setData({ currentTimeText: payload.currentTime.toFixed(1) })
          }
        }
        else {
          pushEvent(this, 'on' + name, payload, name === 'Ended' || name === 'Canplay' ? 'info' : '')
        }
      })
    })
    ctx.autoplay = false
    ctx.volume = this.data.volume / 100
    ctx.playbackRate = this.data.rate
    ctx.loop = this.data.loop
    ctx.src = SOURCES[this.data.source]
    this.audio = ctx
    pushLog(this, '[操作] createInnerAudioContext() 并设置 src=' + ctx.src, 'info')
  },

  startPolling() {
    this.pollTimer = setInterval(() => {
      const ctx = this.audio
      if (!ctx) return
      // duration/currentTime/paused 走 InnerAudio.getState 同步回执
      this.setData({
        durationText: Number(ctx.duration).toFixed(1),
        currentTimeText: Number(ctx.currentTime).toFixed(1),
        pausedText: String(ctx.paused),
      })
    }, 500)
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
  },

  useBundleSource() {
    this.switchSource('bundle')
  },

  useNetSource() {
    this.switchSource('net')
  },

  switchSource(key) {
    if (this.data.source === key || !this.audio) return
    this.setData({ source: key, srcText: SOURCES[key] })
    pushLog(this, '[操作] 切换曲源 → ' + SOURCES[key], 'info')
    // 赋值即触发 InnerAudio.setSrc，验证重载链路
    this.audio.src = SOURCES[key]
  },

  playTapped() {
    pushLog(this, '[操作] play()')
    this.audio.play()
  },

  pauseTapped() {
    pushLog(this, '[操作] pause()')
    this.audio.pause()
  },

  stopTapped() {
    pushLog(this, '[操作] stop()')
    this.audio.stop()
  },

  seekTapped(e) {
    const pos = Number(e.currentTarget.dataset.pos)
    pushLog(this, '[操作] seek(' + pos + ')')
    this.audio.seek(pos)
  },

  rateTapped(e) {
    const rate = Number(e.currentTarget.dataset.rate)
    this.setData({ rate })
    pushLog(this, '[操作] playbackRate = ' + rate)
    this.audio.playbackRate = rate
  },

  volumeChanged(e) {
    const volume = e.detail.value
    this.setData({ volume })
    pushLog(this, '[操作] volume = ' + (volume / 100))
    this.audio.volume = volume / 100
  },

  loopChanged(e) {
    const loop = e.detail.value
    this.setData({ loop })
    pushLog(this, '[操作] loop = ' + loop)
    this.audio.loop = loop
  },

  destroyTapped() {
    pushLog(this, '[操作] destroy()（之后 play 等应为静默 no-op）', 'info')
    this.audio.destroy()
    this.setData({ pausedText: 'true' })
  },

  clearLogs() {
    this.setData({ logs: [] })
  },

  goRecorder() {
    wx.navigateTo({ url: '/pages/recorder/recorder' })
  },
})
