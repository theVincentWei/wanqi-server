// 练习页（全屏）· SPEC-M1 §6.3 + mockup S2/S3 + SPEC-M3 §2.2（听音模式）+ v7.0 原生音频
// 看拼：两格键序槽逐键判；系统键盘：bindinput 比对上屏字。
// 听音（mode=listen）：题卡未答不显示字/拼音/例词/键位徽标，💡 置灰；
//   进题 ~300ms 自动播，答错自动重播 1 次，手动重听不限次。
// 播放器（v7.0 原生主路）：容器 JSSDK 1.0.75+ 提供 wx.createInnerAudioContext（原生
//   MediaPlayer 直读包内相对路径，无 WebView 手势/autoplay 限制）。主路 = 包内 ogg
//   直读：src 赋值即预加载，stop→play 自动重 prepare，完全离线可用。
// 兜底 = 旧链路原样保留：旧容器（缺 API）或原生播放报错 → audioFallback=true，
//   WXML 常驻 <audio> 透传元素 + daemon data-URI（wx.request ?b64=1 JSON 通道）
//   → 其 http 直连 → 再失败 unreachable。状态机四态上屏 + 全程 console.log。
const theme = require('../../utils/theme.js')
const bankData = require('../../utils/charbank.js')

let store = null
try { store = require('../../utils/store.js') } catch (e) { store = null }
let flypy = null
try { flypy = require('../../utils/flypy.js') } catch (e) { flypy = null }
let audioManifest = null
try { audioManifest = require('../../utils/audio.js') } catch (e) { audioManifest = null }

// AppHub 网关固定路径（SPEC-M3 §0，真机 SSH 隧道自带 7610 转发）
const AUDIO_BASE = 'http://127.0.0.1:7610/api/v1/apps/wx3d8b6f2a9c4e7d15'

// mockup S3 静态波形装饰条高度（px×1.92→rpx）
const WAVE_H = [12, 27, 42, 23, 46, 19, 35, 15, 38, 23, 31, 12, 19, 35, 15]

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

// 听音题池：charbank ∩ audio.pool ∩ 所选韵母；池不足所选韵母 → 回退全池；
// 清单缺失（no-pool）→ 仍按所选韵母出题，播放侧逐题走 binderror 降级/toast。
// v1.4.2 起只收 k=char 的单字音频条目——k=ex 的多音字条目音频是「例词」（如卜→萝卜），
// 听到的是词不是字，用户反馈不认可（2026-11-10），剔除后听音=纯单字发音。
// 看拼不做任何回退（保持 M1 行为：所选韵母无题 = toast + 返回）。
function pickPool(chars, finals, pool, listen) {
  const hasPool = !!(listen && pool)
  // hasPool=false（清单缺失降级）时不过滤音频条目，保持旧行为全收
  const charAudio = (c) => {
    if (!c) return false
    if (!hasPool) return true
    const pe = pool[c.char]
    return !!pe && pe.k === 'char'
  }
  const arr = (chars || []).filter((c) => c && finals.indexOf(c.fin) >= 0 && charAudio(c))
  if (hasPool && !arr.length) {
    // 所选韵母无可听字 → 回退全部可听字（同样只收单字条目）
    return {
      arr: (chars || []).filter((c) => charAudio(c)),
      note: '所选韵母暂无可听字，已回退全部可听字',
    }
  }
  return { arr, note: '' }
}

// 从题池随机抽 count 题：先不重复抽完一轮，不足时允许重复
function buildQuestions(poolArr, count) {
  if (!poolArr.length) return []
  const out = []
  let bag = shuffle(poolArr)
  while (out.length < count) {
    if (!bag.length) bag = shuffle(poolArr)
    out.push(bag.pop())
  }
  return out
}

function upper(s) { return String(s || '').toUpperCase() }

// 清单 f 字段语义（M3.5）：'assets/…' = 包内相对路径（离线主路，src 相对文档解析=包目录）；
// 其余（如 'c/9003.mp3'）= daemon 相对路径（旧语义，走在线 data-URI 链路）
function isAssetPath(f) {
  return String(f || '').indexOf('assets/') === 0
}

// 资产条目 → daemon 请求路径映射（daemon 静态根 audio/ 下只有 mp3）：
// "assets/audio/c/53cc.ogg" → "c/53cc.mp3"；非资产条目原样返回
function daemonPathOf(f) {
  const s = String(f || '')
  return isAssetPath(s) ? s.replace(/^assets\/audio\//, '').replace(/\.ogg$/, '.mp3') : s
}

// 原生音频可用性（v7.0 主路开关）：JSSDK 1.0.75+ 容器才有 createInnerAudioContext。
// 惰性探测 + 模块级缓存；探测失败/抛异常按不可用处理（走 daemon 旧链路）。
let natAvailCache = null
function detectNativeAudio() {
  if (natAvailCache !== null) return natAvailCache
  try {
    natAvailCache = typeof wx !== 'undefined' && typeof wx.createInnerAudioContext === 'function'
  } catch (e) { natAvailCache = false }
  return natAvailCache
}

// 题目装饰：拼音分色（声母蓝/韵母橙）、hint 徽标（声母 sh→U / 韵母 uang→L）
function decorate(c) {
  const ini = c.ini || ''
  const fin = c.fin || ''
  const keys = String(c.keys || '').toLowerCase()
  const py = c.py || c.py0 || ''
  const py0 = c.py0 || ''
  let smText = ''
  let fmText = py
  if (ini) smText = py.slice(0, ini.length) // 带调拼音按声母长度截取（ü 等组合字符单码点，slice 安全）
  if (ini) fmText = py.slice(ini.length)
  const k1 = keys.charAt(0)
  const k2 = keys.charAt(1)
  const h1t = ini ? ('声母 ' + ini + ' → ') : ('首字母 ' + (py0.charAt(0) || '') + ' → ')
  const h2t = '韵母 ' + fin + ' → '
  return {
    char: c.char, py, py0, ini, fin,
    ex: c.multi ? (c.ex || '') : '',
    keys, keysUp: upper(keys),
    smText, fmText,
    h1t, h1k: upper(k1), h2t, h2k: upper(k2),
  }
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

Page({
  data: {
    theme: 'light',
    ready: false,
    mode: 'look',       // look | listen
    input: 'builtin',   // builtin | system
    hint: false,
    q: null,
    idx: 0,
    total: 0,
    progress: 0,
    s1: '', s2: '',
    cls1: 'cur', cls2: '',
    vType: '', vPre: '', vKeys: '', vPost: '',
    clock: '0:00',
    accText: '--',
    hlKeys: '',
    sysVal: '',
    sysFocus: false,
    // 听音模式
    tagText: '',        // 揭示层例词 chip：看拼=例词；听音=「词：双向」
    audioState: 'idle', // idle | loading | ready | retry | unreachable
    audioStateText: '', // 波形下状态行（真机截图自证）
    audioSrc: '',       // 仅兜底链路用（<audio> 元素 src；原生主路不走这里）
    audioFallback: false, // true = 原生主路不可用（旧容器/原生报错），显示 <audio> 条
    listenTip: '▶ 进题自动播 · 点 ▶ 随时重听（不限次）',
    waveH: WAVE_H,
  },

  onLoad(options) {
    try { this.detachTheme = theme.attach(this) } catch (e) { this.setData({ theme: 'light' }) }

    let finalsRaw = options.finals || ''
    try { finalsRaw = decodeURIComponent(finalsRaw) } catch (e) { /* 已是明文 */ }
    const finals = finalsRaw.split(',').map((s) => s.trim()).filter(Boolean)

    const count = Math.max(1, Math.min(50, parseInt(options.count, 10) || 20))
    const mode = options.mode === 'listen' ? 'listen' : 'look'
    const input = options.input === 'system' ? 'system' : 'builtin'
    // 键位提示对听音模式无意义（💡 置灰），强制按关处理
    const hint = options.hint === '1' && mode !== 'listen'

    this.per = []
    this.state = 'input'
    this.typed = ''
    this.timeouts = []
    this.mode = mode
    this.audioSeq = 0
    this.audioLoading = false
    this.lastErrSrc = null
    this.unreachToasted = false
    this.qAudio = null
    this.qPoolEx = ''
    // 原生音频（v7.0）：实例懒创建；natBroken 置真后本会话粘住 daemon 兜底
    this.natAudio = null
    this.natBroken = false

    // 空池视同清单缺失（集成时序上 audio.js 可能先于 manifest 数据合入）
    const rawPool = audioManifest && audioManifest.pool ? audioManifest.pool : null
    const pool = rawPool && Object.keys(rawPool).length ? rawPool : null
    const picked = pickPool((bankData && bankData.chars) || [], finals, pool, mode === 'listen')
    const list = buildQuestions(picked.arr, count)
    if (!list.length) {
      this.setData({ ready: false })
      wx.showToast({ title: '该韵母下暂无题目', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    let note = picked.note
    if (mode === 'listen' && !pool) {
      note = '音频清单缺失，听音题池退化' // no-pool 降级：照常出题，播放侧走降级路径
    }
    if (note) {
      wx.showToast({ title: note, icon: 'none' })
    }

    this.questions = list
    this.finals = finals
    this.pool = pool
    this.startTs = Date.now()
    this.qStart = Date.now()

    this.setData({
      ready: true,
      mode,
      input,
      hint,
      sysFocus: input === 'system',
      total: list.length,
    })
    this.loadQ(0)

    this.timer = setInterval(() => {
      this.setData({ clock: fmtClock(Date.now() - this.startTs) })
    }, 1000)
  },

  onUnload() {
    try { this.detachTheme && this.detachTheme() } catch (e) { /* ignore */ }
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    ;(this.timeouts || []).forEach((t) => clearTimeout(t))
    // 原生音频实例：页面卸载即销毁（MediaPlayer 释放 + 焦点归还）
    try { if (this.natAudio) { this.natAudio.destroy(); this.natAudio = null } } catch (e) { /* ignore */ }
  },

  applyTheme(t) {
    this.setData({ theme: t })
  },

  scheduleNext(delay) {
    const t = setTimeout(() => this.next(), delay)
    this.timeouts.push(t)
  },

  loadQ(idx) {
    const q = decorate(this.questions[idx])
    this.state = 'input'
    this.typed = ''
    this.qStart = Date.now()
    this.audioLoading = false
    this.lastErrSrc = null
    this.unreachToasted = false

    // 听音：当前题音频文件与例词（kind=ex 时音频读的是例词）
    const pe = this.pool && this.pool[q.char] ? this.pool[q.char] : null
    this.qAudio = pe ? pe.f : null
    this.qPoolEx = pe && pe.k === 'ex' ? (pe.ex || '') : ''

    const isListen = this.mode === 'listen'
    const tagText = isListen
      ? (this.qPoolEx ? '词：' + this.qPoolEx : (q.ex ? '词：' + q.ex : ''))
      : q.ex

    const token = (this.qToken || 0) + 1
    this.qToken = token

    this.setData({
      q,
      idx,
      progress: Math.round(((idx + 1) / this.questions.length) * 100),
      s1: '', s2: '',
      cls1: 'cur', cls2: '',
      vType: '', vPre: '', vKeys: '', vPost: '',
      hlKeys: this.data.hint ? q.keys.split('').join(',') : '',
      sysVal: '',
      tagText,
      audioState: 'idle',
      audioStateText: '',
      // 兜底显示条件（v1.4.2 回归修复）：原生 API 不存在（旧容器，探测为 false）
      // 或本会话原生报错粘住（natBroken）——两者都要露出 <audio> 条走 daemon 旧链路。
      // 漏掉前者会让旧容器「拉了流却永远没有播放键可点」。
      audioFallback: this.natBroken || !detectNativeAudio(),
    })

    // 听音：题面渲染后 ~300ms 进题自动播（原生主路无手势限制，真自动出声；
    // 兜底链路此时只是预拉流，出声仍需用户点 <audio> 播放键——WebView 策略限制）
    if (isListen) {
      const t = setTimeout(() => {
        if (this.qToken === token && this.state === 'input') {
          console.log('[sp-audio] auto play on load, q', idx + 1)
          this.loadAudio()
        }
      }, 300)
      this.timeouts.push(t)
    }
  },

  // ---- 听音播放器 v7.0（原生 InnerAudioContext 直读包内 + daemon data-URI 兜底）----
  // 主路（新容器，完全离线）：qAudio 为包内资产 → a.src = f（相对路径，原生侧
  //   PathUtils 先查 filesDir/jsapp/<appid>/ 直下再回落 main/）→ stop() → play()
  //   （flappy-bird 同款：重申 src + stop + play，原生自动重 prepare，无手势限制）。
  // 兜底（旧容器缺 API / 非资产条目 / 原生报错）：daemon data-URI 旧链路原样保留
  //   （wx.request ?b64=1 JSON → <audio> 元素 data-URI → http 直连 → unreachable）。
  // 全程 console.log，真机 vConsole 直接看链路。

  setAudioState(s) {
    const TEXT = {
      idle: '',
      loading: '加载中…',
      ready: '就绪 ✓',
      playing: '▶ 播放中 ✓',
      retry: '播放失败 点▶重试',
      unreachable: '音频服务不可达',
    }
    this.setData({ audioState: s, audioStateText: TEXT[s] || '' })
  },

  // 原生实例懒创建（幂等）。事件只刷状态行；onError 把会话粘到兜底链路。
  natInit() {
    if (this.natAudio) return this.natAudio
    if (!detectNativeAudio()) return null
    try {
      const a = wx.createInnerAudioContext()
      a.onPlay(() => {
        console.log('[sp-audio] nat play 事件 — 声音真的在播')
        this.setAudioState('playing')
      })
      a.onEnded(() => {
        console.log('[sp-audio] nat ended 事件 — 本题音频播放完成')
        this.setAudioState('idle')
      })
      a.onError((res) => {
        const why = res && (res.errMsg || res.errCode)
        console.log('[sp-audio] nat error:', why, '→ 粘住 daemon 兜底')
        this.natBroken = true
        this.setData({ audioFallback: true })
        this.fallbackDaemon()
      })
      this.natAudio = a
      console.log('[sp-audio] nat context created')
    } catch (e) {
      console.log('[sp-audio] nat init failed:', e)
      this.natBroken = true
      this.setData({ audioFallback: true })
    }
    return this.natAudio
  },

  onAudioPlay() {
    console.log('[sp-audio] play 事件 — 声音真的在播')
    this.setAudioState('playing')
  },
  onAudioEnded() {
    console.log('[sp-audio] ended 事件 — 本题音频播放完成')
  },

  // 原生主路：src 重申 + stop + play（重启从头播，重听不限次）
  // 兜底：daemon data-URI 旧链路（f 为 daemon 相对路径的旧语义清单也走这里）
  loadAudio(force) {
    if (this.mode !== 'listen') return
    if (!force && this.state !== 'input') return
    if (this.audioLoading) return
    if (!this.qAudio) {
      // no-pool 降级抽到的字没有音频
      this.setAudioState('unreachable')
      wx.showToast({ title: '该字暂无音频', icon: 'none' })
      return
    }
    if (!this.natBroken && detectNativeAudio() && isAssetPath(this.qAudio)) {
      const a = this.natInit()
      if (a) {
        console.log('[sp-audio] nat load:', this.qAudio)
        this.setAudioState('loading')
        try {
          // 顺序铁律（AudioApi 状态机，2026-11-10 真机复现教训）：stop → setSrc → play。
          // 反序（src→stop→play）时 play 落在 stopped 态走 reprepare()，用的是上次
          // 解析的旧 resolvedSrc，且 generation++ 会作废新源进行中的 prepare——
          // 表现为「每题都放同一条音频」。flappy 同序不出事是因为它 src 恒定同源。
          a.stop()
          a.src = this.qAudio // 相对路径不带斜杠不带 query；setSrc 重置状态机并预加载新源
          a.play() // 未 prepared 态记 pendingPlay，新源 onPrepared 自动起播
          return
        } catch (e) {
          console.log('[sp-audio] nat play threw:', e, '→ daemon 兜底')
          this.natBroken = true
          this.setData({ audioFallback: true })
        }
      }
    }
    this.fetchDaemon()
  },

  // 在线主路：daemon 拉流 → data-URI（f 为 daemon 相对路径的旧语义也走这里）
  // 容器 wx.request 对 responseType:'arraybuffer' 支持不佳（200 但 data 空，仿真器
  // logcat 实证）——改走 daemon ?b64=1 JSON 通道（sys-monitor 同款可靠 JSON 路径）。
  fetchDaemon() {
    if (this.audioLoading) return
    this.audioLoading = true
    // 资产条目映射到 daemon mp3 布局（daemon 静态根 audio/ 只有 mp3）：
    // assets/audio/c/53cc.ogg → /audio/c/53cc.mp3
    const path = daemonPathOf(this.qAudio)
    console.log('[sp-audio] fetch daemon:', this.qAudio, '→', path)
    this.setAudioState('loading')
    wx.request({
      url: AUDIO_BASE + '/audio/' + path + '?b64=1',
      success: (r) => {
        this.audioLoading = false
        const b64 = r && r.data && r.data.b64
        if (r && r.statusCode === 200 && b64) {
          this.audioSeq += 1
          const src = 'data:audio/mpeg;base64,' + b64 + '#' + this.audioSeq
          console.log('[sp-audio] fetched b64 len:', b64.length,
            '| seq:', this.audioSeq)
          this.setData({ audioSrc: src })
          this.setAudioState('ready')
          return
        }
        console.log('[sp-audio] fetch bad response, status:', r && r.statusCode,
          'dataType:', r && typeof r.data)
        this.setAudioState('unreachable')
        if (!this.unreachToasted) {
          this.unreachToasted = true
          wx.showToast({ title: '音频服务不可达（主机未连？）', icon: 'none' })
        }
      },
      fail: (e) => {
        this.audioLoading = false
        console.log('[sp-audio] fetch fail:', e && e.errMsg)
        this.setAudioState('unreachable')
        if (!this.unreachToasted) {
          this.unreachToasted = true
          wx.showToast({ title: '音频服务不可达（主机未连？）', icon: 'none' })
        }
      },
    })
  },

  // 资产播放失败（binderror）→ 退回 daemon 在线链路
  fallbackDaemon() {
    if (!this.qAudio) { this.setAudioState('unreachable'); return }
    this.fetchDaemon()
  },

  // data-URI 拉流失败的次级兜底：http 直连 src 一次；binderror 再来 → unreachable
  fallbackHttp() {
    if (!this.qAudio) { this.setAudioState('unreachable'); return }
    this.audioSeq += 1
    const src = AUDIO_BASE + '/audio/' + daemonPathOf(this.qAudio) + '?r=' + this.audioSeq
    console.log('[sp-audio] fallback http src:', src)
    this.setData({ audioSrc: src })
    this.setAudioState('retry')
  },

  onAudioErr() {
    const src = String(this.data.audioSrc || '')
    if (!src) return
    if (src === this.lastErrSrc) return // 同一 src 的 error 只处理一次
    this.lastErrSrc = src
    console.log('[sp-audio] error event | src head:', src.slice(0, 30))
    if (src.indexOf('data:') === 0) {
      // data-URI 挂载失败（罕见）→ http 直连兜底
      this.fallbackHttp()
    } else if (src.indexOf('http') === 0) {
      this.setAudioState('unreachable')
      if (!this.unreachToasted) {
        this.unreachToasted = true
        wx.showToast({ title: '音频服务不可达（主机未连？）', icon: 'none' })
      }
    } else {
      // 包内资产失败 → daemon 在线兜底
      this.fallbackDaemon()
    }
  },

  // 播放大按钮：手动重听，不限次（2026-11-10 用户拍板：取消计次）。
  // 原生主路 = 从头重播；兜底链路 = 重拉流。加载中忽略；不可达时 = 免费重试。
  onPlayTap() {
    if (this.state !== 'input') return
    if (this.data.audioState === 'loading') return
    this.loadAudio(true)
  },

  toggleHint() {
    if (this.mode === 'listen') return // 💡 对听音无意义
    const hint = !this.data.hint
    this.setData({
      hint,
      hlKeys: hint && this.data.q ? this.data.q.keys.split('').join(',') : '',
    })
    // 只对本次练习生效，不回写配置
  },

  onClose() {
    wx.navigateBack()
  },

  // ---- 内置键盘 ----
  onKey(e) {
    if (this.state !== 'input' || this.data.input !== 'builtin') return
    const k = String((e.detail && e.detail.key) || '').toLowerCase()
    if (!/^[a-z]$/.test(k)) return
    const typed = this.typed + k
    this.typed = typed
    if (typed.length === 1) {
      this.setData({ s1: k.toUpperCase(), cls2: 'cur' })
    } else {
      this.setData({ s2: k.toUpperCase() })
      this.judge(typed, true)
    }
  },

  onDel() {
    if (this.state !== 'input' || this.data.input !== 'builtin') return
    if (!this.typed) return
    this.typed = ''
    this.setData({ s1: '', s2: '', cls1: 'cur', cls2: '' })
  },

  // ---- 系统键盘：三重触发（bindinput / confirm+blur / 「判」按钮）----
  // 判定时机（输入个数到位即判）：
  //   · 上屏汉字 → 按字判
  //   · 拼音组词中（双拼两键即出全拼；全拼逐字母）：
  //       latin === 目标全拼 → 判对（双拼两键正好达到）
  //       latin 长度 ≥ 目标全拼长度仍不匹配 → 判错（组词已超长，必错）
  //       长度不足 → 继续等（全拼中途态不误判）
  //   · blur/confirm/判按钮 → 强制判（组词已结束）
  sysJudgeValue(v, force) {
    if (this.state !== 'input' || this.data.input !== 'system') return
    const val = String(v || '')
    if (/[\u4e00-\u9fa5]/.test(val)) {
      this.judge(val, false)
      this.sysVal = ''
      this.setData({ sysVal: '' })
      return
    }
    const latin = val.toLowerCase().replace(/[^a-z]/g, '')
    if (!latin) return
    const py0 = (this.data.q && this.data.q.py0) || ''
    if (!py0) return
    let okNow = false
    try { if (flypy && flypy.check) { const r = flypy.check(latin, py0); okNow = !!(r && r.ok) } } catch (e) {}
    if (latin === py0) okNow = true
    if (!okNow && !force && latin.length < py0.length) return // 组词未完，继续等
    this.judge(val, false, okNow)
    this.sysVal = ''
    this.setData({ sysVal: '' })
  },
  onSysInput(e) {
    this.sysJudgeValue((e.detail && e.detail.value) || '', false)
  },
  onSysConfirm() {
    this.sysJudgeValue(this.sysVal || this.data.sysVal, true)
  },
  onSysBlur() {
    this.sysJudgeValue(this.sysVal || this.data.sysVal, true)
  },
  onSysJudgeTap() {
    this.sysJudgeValue(this.data.sysVal || this.sysVal || '', true)
  },

  judge(input_, builtin, okOverride) {
    const q = this.data.q
    if (!q) return
    const ms = Date.now() - this.qStart
    let ok = false
    let expected = q.keys
    if (typeof okOverride === 'boolean') {
      ok = okOverride
    } else if (builtin) {
      let r = null
      try { if (flypy && flypy.check) r = flypy.check(input_, q.py0) } catch (err) { r = null }
      ok = r ? !!r.ok : input_ === q.keys
      if (r && r.expected) expected = r.expected
    } else {
      const m = String(input_).match(/[\u4e00-\u9fa5]/)
      ok = !!m && String(input_).indexOf(q.char) >= 0
    }

    const typedRaw = builtin ? this.typed : String(input_ || '').slice(0, 8)
    this.per.push({
      char: q.char, py0: q.py0, keys: q.keys, typed: typedRaw, ok, ms,
      ini: q.ini, fin: q.fin,
    })
    this.state = ok ? 'ok' : 'err'

    const answered = this.per.length
    const correct = this.per.filter((p) => p.ok).length
    const pct = answered ? Math.round((correct * 100) / answered) : 0

    let cls = ''
    let vPre = ''
    let vKeys = ''
    let vPost = ''
    if (ok) {
      cls = 'ok'
      vPre = '✓ 正确 · ' + q.char + ' ' + q.py + (builtin ? ' = ' : '')
      if (builtin) vKeys = q.keysUp
    } else {
      cls = 'err'
      if (builtin) {
        vPre = '✗ 应为 '
        vKeys = upper(expected)
      } else {
        const shown = (String(input_).match(/[\u4e00-\u9fa5]/) || [''])[0]
        vPre = '✗ 你打「' + shown + '」 · 应为「' + q.char + '」'
      }
    }

    this.setData({
      cls1: cls, cls2: cls,
      vType: cls, vPre, vKeys, vPost,
      accText: pct + '%',
    })
    // 听音：答错自动重播 1 次（不消耗手动次数），边错边听强化
    if (!ok && this.mode === 'listen') this.loadAudio(true)
    this.scheduleNext(ok ? 400 : 800)
  },

  next() {
    const done = this.data.idx + 1
    if (done >= this.questions.length) {
      this.finish()
    } else {
      this.loadQ(done)
    }
  },

  finish() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    const correct = this.per.filter((p) => p.ok).length
    let id = ''
    try {
      if (store && store.recordSession) {
        const r = store.recordSession({
          mode: this.mode,
          finals: this.finals || [],
          input: this.data.input, // 附加字段：结果页「再来一组」还原参数用（schema 兼容的加列）
          count: this.questions.length,
          correct,
          durationMs: Date.now() - this.startTs,
          per: this.per,
          ts: Date.now(),
        })
        id = (r && r.id) != null ? String(r.id) : ''
      }
    } catch (e) { /* 存储兜底：结果页会回退取最近一条 */ }
    wx.redirectTo({ url: '/pages/result/result?id=' + encodeURIComponent(id || 'na') })
  },
})
