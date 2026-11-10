/**
 * 星际穿行（Star Drift）· 渲染层（M2）
 *
 * 职责：view.render(eng, nowMs) 每帧读 eng 全量状态 → 同步 three 场景 → render。
 * 不持有玩法逻辑；不碰 canvas.width/height（分辨率铁律在 createRenderer 内部执行）。
 *
 * 坐标系（engine.js 契约，船体系）：飞船恒在 (player.x, 0, 0)，世界物体 z<0 在前方、
 * 每帧向 +z 滚动、z>DESPAWN_BEHIND(14) 被引擎回收——渲染层只镜像 state，不做生命周期。
 *
 * 视觉参数 = M1 精修稿（用户已拍板）：fov60 追尾 @(0,1.25,6.4) lookAt -18 / ACES exposure 1.2
 * + environmentIntensity 1.15 / 追尾主光在镜头侧 / 带环行星 / 三层星点+十字亮星 /
 * LineSegments 星尘拖线（环形分布避中道，速度接 eng.speed）/ 双层引擎尾焰 / 翼尖航行灯 /
 * 双色系 detail2 小行星 / 晶体 halo / 科幻 HUD。
 *
 * 资产链路（quickJS 小游戏环境）：本文件自带资产桥补丁（参照 three-bench adapter）——
 *   - 全局垫片 self/window/navigator/TextDecoder/document.createElementNS(img→wx.createImage)
 *   - 贴图 src 翻译 pkg:/assets/X → https://appassets.androidplatform.net/<appId>/main/assets/X
 *   - THREE.FileLoader.prototype.load 拦 pkg:/ 前缀 → wx.getFileSystemManager().readFileSync
 * 飞船加载链：wx 环境 pkg:/assets/omen.gltf →（浏览器 harness）globalThis.__STAR_DRIFT_SHIP_DATA__
 * →（都没有）程序化占位飞船——任何环境都不崩。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ---- Dimina 小游戏资产桥（wx 环境才安装；浏览器 harness 自动跳过） ----
const APP_ID = 'wx8c4e2f6a9d1b7e53'
const ASSET_DOMAIN = 'https://appassets.androidplatform.net/' + APP_ID + '/main'

function translateSrc(url) {
  if (typeof url !== 'string') return url
  if (url.startsWith('pkg:/assets/')) return ASSET_DOMAIN + '/assets/' + url.slice('pkg:/assets/'.length)
  if (url.startsWith('assets/')) return ASSET_DOMAIN + '/' + url
  return url
}

function installMiniGameBridge() {
  if (typeof globalThis.wx === 'undefined' || !globalThis.wx) return
  if (globalThis.__starDriftBridgeInstalled) return
  globalThis.__starDriftBridgeInstalled = true
  const g = globalThis
  if (typeof g.self === 'undefined') g.self = g
  if (typeof g.window === 'undefined') g.window = g
  if (typeof g.navigator === 'undefined') g.navigator = { userAgent: 'dimina-quickjs' }
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = function TextDecoder() {}
    g.TextDecoder.prototype.decode = function () { return '' }
  }
  if (typeof g.document === 'undefined') {
    g.document = {
      createElementNS(_ns, tag) {
        if (tag === 'img') {
          const image = wx.createImage()
          const wrapper = {
            get width() { return image.width },
            get height() { return image.height },
            addEventListener(type, listener) {
              if (type === 'load') image.onload = () => { diag('img LOAD fired:', image.src); listener() }
              else if (type === 'error') image.onerror = () => { diag('img ERROR fired:', image.src); listener() }
            },
            removeEventListener(type, listener) {
              if (type === 'load' && image.onload === listener) image.onload = null
              if (type === 'error' && image.onerror === listener) image.onerror = null
            },
          }
          Object.defineProperty(wrapper, 'src', {
            set(value) {
              diag('img.src set:', value)
              image.src = translateSrc(value)
            },
            get() { return image.src },
          })
          return wrapper
        }
        if (tag === 'canvas') return wx.createCanvas()
        throw new Error('createElementNS unsupported tag: ' + tag)
      },
    }
  }
  // FileLoader 原型补丁：pkg:/ 前缀走 readFileSync（同步读包内文件，调用方本就在回调流里）
  const origLoad = THREE.FileLoader.prototype.load
  THREE.FileLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    if (typeof url === 'string' && url.startsWith('pkg:/')) {
      const path = url.slice('pkg:/'.length)
      try {
        const data = wx.getFileSystemManager().readFileSync(path)
        diag('FileLoader read:', path, '->', (data && data.byteLength) || -1, 'bytes')
        if (onLoad) onLoad(data)
        return data
      } catch (error) {
        diag('FileLoader READ FAILED:', path, '|', error && error.message)
        if (onError) onError(error)
        else throw error
      }
    }
    if (typeof url === 'string' && url.startsWith('data:application/octet-stream;base64,')) {
      // 内联 buffer：同步解码，绝不走原实现（QuickJS 无 fetch，回落必挂）
      try {
        const bytes = base64ToBytes(url)
        const buf = bytes.buffer
        diag('FileLoader data URI ->', bytes.length, 'bytes')
        if (onLoad) onLoad(buf)
        return buf
      } catch (error) {
        diag('FileLoader data URI decode FAILED:', error && error.message)
        if (onError) onError(error)
        else throw error
      }
    }
    return origLoad.call(this, url, onLoad, onProgress, onError)
  }
  // TextureLoader 贴图加载日志（appassets URL + onload/onerror 各一条）
  const origTexLoad = THREE.TextureLoader.prototype.load
  THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    diag('TextureLoader:', url)
    const wrappedOn = onLoad
      ? function (tex) {
        diag('TextureLoader OK:', url, tex && tex.image && tex.image.width ? (tex.image.width + 'x' + tex.image.height) : '')
        if (wrappedOn) wrappedOn(tex)
      }
      : onLoad
    const wrappedOff = onError
      ? function (err) {
        diag('TextureLoader ERROR:', url, err && (err.message || err))
        if (onError) onError(err)
      }
      : onError
    return origTexLoad.call(this, url, wrappedOn, onProgress, wrappedOff)
  }
}
installMiniGameBridge()

// ============================================================
// 视觉常量（M1 精修稿定稿，用户已拍板，禁止随手改）
// ============================================================
const PAL = {
  space: '#0a1220',
  keyLight: '#d5e6ff',
  fillLight: '#8fb4d8',
  hemiSky: '#31456b',
  hemiGround: '#0a0f18',
  rimLight: '#6fb0ff',
  asteroidIce: '#7fa3c0',
  asteroidRock: '#8a6440',
  crystal: '#26e0c2',
  engine: '#1e8dff',
  flame: '#2fc8ff',
  flameCore: '#e8fbff',
  dustNear: '#9fd4ff',
  dustFar: '#6f9fd0',
}
const CAM_POS = new THREE.Vector3(0, 1.25, 6.4)
const CAM_LOOK = new THREE.Vector3(0, 0.5, -18)
const CAM_PARALLAX = 0.3 // 相机横向跟随飞船比例（视差感）
const FOV = 60
const EXPOSURE = 1.2
const ENV_INTENSITY = 1.15
const SHIP_LENGTH = 2.15 // 飞船长归一（世界单位）
const DUST_SPEED_NEAR = 1.9 // 星尘近层速度 = eng.speed × 该系数
const DUST_SPEED_FAR = 1.2
const DUST_OPACITY = 0.42
const FLARE_COUNT = 6

// ---- 体素/程序化几何工具 ----
function mergedBoxGeometry(specs) {
  const pos = []
  const nor = []
  const col = []
  const color = new THREE.Color()
  for (const sp of specs) {
    const g = new THREE.BoxGeometry(sp.w, sp.h, sp.d).toNonIndexed()
    g.translate(sp.x, sp.y, sp.z)
    color.set(sp.c)
    const p = g.attributes.position.array
    const n = g.attributes.normal.array
    for (let j = 0; j < p.length; j += 3) {
      pos.push(p[j], p[j + 1], p[j + 2])
      nor.push(n[j], n[j + 1], n[j + 2])
      col.push(color.r, color.g, color.b)
    }
    g.dispose()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return geo
}

// ---- 程序化贴图 ----
const SD_DIAG = true
function diag(...args) {
  if (SD_DIAG) console.log('[stardrift]', ...args)
}

// 大程序化贴图（equirect/行星/环）一律走 DataTexture 逐像素 RGBA：
// v1.0.1 设备实测（214 仿真器）2d canvas → CanvasTexture 桥在 512² 以上静默变黑
// （128² 的 halo/flare 正常），故绕开 2d 桥；低分辨率 + LinearFilter 对柔渐变无损。
function makeEquirectDataTexture() {
  const w = 256, h = 128
  const data = new Uint8Array(w * h * 4)
  // 星云团（u,v 归一化；v=0 天底=数组首行，v=1 天顶）
  const blobs = [
    { u: 0.25, v: 0.40, r: 0.22, c: [23, 112, 124], a: 0.18 },
    { u: 0.29, v: 0.42, r: 0.11, c: [37, 165, 176], a: 0.13 },
    { u: 0.21, v: 0.34, r: 0.06, c: [63, 210, 207], a: 0.10 },
    { u: 0.74, v: 0.64, r: 0.23, c: [124, 45, 104], a: 0.17 },
    { u: 0.70, v: 0.59, r: 0.11, c: [176, 68, 140], a: 0.12 },
    { u: 0.79, v: 0.71, r: 0.06, c: [216, 107, 168], a: 0.09 },
    { u: 0.58, v: 0.24, r: 0.15, c: [143, 106, 42], a: 0.13 },
    { u: 0.54, v: 0.20, r: 0.07, c: [201, 160, 74], a: 0.10 },
    { u: 0.12, v: 0.74, r: 0.15, c: [44, 74, 143], a: 0.14 },
    { u: 0.43, v: 0.80, r: 0.13, c: [29, 90, 143], a: 0.10 },
    { u: 0.88, v: 0.22, r: 0.13, c: [90, 58, 143], a: 0.12 },
  ]
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1)
    let br = 4, bg = 7, bb = 12
    if (v > 0.42) {
      const t1 = Math.min(1, (v - 0.42) / 0.3)
      br += 6 * t1; bg += 11 * t1; bb += 19 * t1
    }
    if (v > 0.72) {
      const t2 = Math.min(1, (v - 0.72) / 0.28)
      br -= 3 * t2; bg -= 6 * t2; bb -= 10 * t2
    }
    for (let x = 0; x < w; x++) {
      const u = x / w
      let r = br, g = bg, b = bb
      for (const bl of blobs) {
        let du = u - bl.u
        du -= Math.round(du)
        const dv = (v - bl.v) * 0.62
        const d2 = (du * 2) * (du * 2) + dv * dv
        const rr = d2 / (bl.r * bl.r)
        if (rr < 1) {
          const f = (1 - rr) * (1 - rr)
          const a = f * bl.a
          r = r * (1 - a) + bl.c[0] * a
          g = g * (1 - a) + bl.c[1] * a
          b = b * (1 - a) + bl.c[2] * a
        }
      }
      const bv = v - 0.52 + (u - 0.5) * 0.18
      const bg2 = Math.exp(-(bv * bv) / 0.012)
      r += 150 * bg2 * 0.09; g += 170 * bg2 * 0.09; b += 200 * bg2 * 0.09
      const i4 = (y * w + x) * 4
      data[i4] = Math.min(255, r | 0)
      data[i4 + 1] = Math.min(255, g | 0)
      data[i4 + 2] = Math.min(255, b | 0)
      data[i4 + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, w, h)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  diag('equirect DataTexture', w + 'x' + h, 'ready')
  return tex
}

/** 一次性 canvas 能力探针（v1.0.2 诊断：2d 桥 gradient/getImageData 设备实测） */
function probeCanvasBridge() {
  try {
    const cv = makeHudSizedCanvas(512, 512)
    const ctx = cv && cv.getContext('2d')
    if (!ctx) { diag('canvas probe: no 2d ctx'); return }
    diag('canvas probe: size after 512 set =', cv.width, 'x', cv.height,
      '| linearGrad:', typeof ctx.createLinearGradient,
      '| radialGrad:', typeof ctx.createRadialGradient,
      '| getImageData:', typeof ctx.getImageData)
    const g = ctx.createLinearGradient(0, 0, 0, 512)
    g.addColorStop(0, '#205080')
    g.addColorStop(1, '#050810')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 512, 512)
    try {
      const px = ctx.getImageData(256, 60, 1, 1).data
      diag('canvas probe: gradient pixel rgba =', px[0], px[1], px[2], px[3], '(期望≈32,80,128,255；全0=2d桥黑)')
    } catch (e) {
      diag('canvas probe: getImageData threw:', e && e.message)
    }
  } catch (e) {
    diag('canvas probe threw:', e && e.message)
  }
}

function makeHudSizedCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    return cv
  }
  if (typeof wx !== 'undefined' && wx && typeof wx.createCanvas === 'function') {
    const cv = wx.createCanvas()
    cv.width = w
    cv.height = h
    return cv
  }
  return null
}

function makeGlowTexture(color = '120,240,220') {
  const cv = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas')
  cv.width = 128
  cv.height = 128
  const ctx = cv.getContext('2d')
  const rg = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  rg.addColorStop(0, `rgba(${color},0.9)`)
  rg.addColorStop(0.3, `rgba(${color},0.38)`)
  rg.addColorStop(0.65, `rgba(${color},0.10)`)
  rg.addColorStop(1, `rgba(${color},0)`)
  ctx.fillStyle = rg
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeFlareTexture(coreColor, rayColor) {
  const cv = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas')
  cv.width = 128
  cv.height = 128
  const ctx = cv.getContext('2d')
  const c = 64
  let rg = ctx.createRadialGradient(c, c, 0, c, c, 34)
  rg.addColorStop(0, `rgba(${coreColor},0.95)`)
  rg.addColorStop(0.4, `rgba(${rayColor},0.30)`)
  rg.addColorStop(1, `rgba(${rayColor},0)`)
  ctx.fillStyle = rg
  ctx.fillRect(0, 0, 128, 128)
  for (const [len, wdt] of [[60, 3.2], [38, 2]]) {
    const gh = ctx.createLinearGradient(c - len, c, c + len, c)
    gh.addColorStop(0, `rgba(${rayColor},0)`)
    gh.addColorStop(0.5, `rgba(${coreColor},0.9)`)
    gh.addColorStop(1, `rgba(${rayColor},0)`)
    ctx.fillStyle = gh
    ctx.fillRect(c - len, c - wdt / 2, len * 2, wdt)
    const gv = ctx.createLinearGradient(c, c - len, c, c + len)
    gv.addColorStop(0, `rgba(${rayColor},0)`)
    gv.addColorStop(0.5, `rgba(${coreColor},0.9)`)
    gv.addColorStop(1, `rgba(${rayColor},0)`)
    ctx.fillStyle = gv
    ctx.fillRect(c - wdt / 2, c - len, wdt, len * 2)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makePlanetDataTexture() {
  const w = 256, h = 128
  const data = new Uint8Array(w * h * 4)
  const pal = [
    [184, 144, 96], [138, 100, 56], [110, 76, 48], [168, 128, 78],
    [94, 64, 40], [148, 104, 74], [122, 86, 56], [176, 142, 94],
    [78, 54, 32], [132, 96, 62], [116, 82, 46], [170, 135, 88],
  ]
  let s = 4242
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const streaks = []
  for (let i = 0; i < 90; i++) {
    streaks.push({ y: rand(), w: rand() < 0.5 ? [240, 226, 164] : [74, 52, 32], x0: rand(), len: 0.12 + rand() * 0.6, a: 0.10 + rand() * 0.14 })
  }
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1)
    const bandF = v * (pal.length - 1)
    const bi = Math.min(pal.length - 2, bandF | 0)
    const ft = bandF - bi
    const r0 = pal[bi][0] + (pal[bi + 1][0] - pal[bi][0]) * ft
    const g0 = pal[bi][1] + (pal[bi + 1][1] - pal[bi][1]) * ft
    const b0 = pal[bi][2] + (pal[bi + 1][2] - pal[bi][2]) * ft
    const pole = Math.min(1, Math.abs(v - 0.5) * 2.4)
    for (let x = 0; x < w; x++) {
      const u = x / w
      let r = r0, g = g0, b = b0
      for (const st of streaks) {
        if (Math.abs(v - st.y) < 0.012) {
          let du = u - st.x0
          du -= Math.round(du)
          if (du >= 0 && du < st.len) {
            r += (st.w[0] - r) * st.a
            g += (st.w[1] - g) * st.a
            b += (st.w[2] - b) * st.a
          }
        }
      }
      r *= 1 - pole * 0.5
      g *= 1 - pole * 0.5
      b *= 1 - pole * 0.5
      const i4 = (y * w + x) * 4
      data[i4] = r | 0
      data[i4 + 1] = g | 0
      data[i4 + 2] = b | 0
      data[i4 + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, w, h)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  diag('planet DataTexture', w + 'x' + h, 'ready')
  return tex
}

function makeRingDataTexture() {
  const w = 128, h = 128
  const data = new Uint8Array(w * h * 4)
  const bands = [
    [0.70, 0.80, [196, 168, 120], 0.72],
    [0.82, 0.89, [160, 138, 96], 0.50],
    [0.905, 0.945, [214, 196, 158], 0.62],
    [0.958, 0.985, [150, 130, 95], 0.40],
  ]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w - 0.5
      const dy = (y + 0.5) / h - 0.5
      const r = Math.sqrt(dx * dx + dy * dy) * 2
      let rr = 0, gg = 0, bb = 0, aa = 0
      for (const [b0, b1, c, a] of bands) {
        if (r >= b0 && r <= b1) { rr = c[0]; gg = c[1]; bb = c[2]; aa = a * 255; break }
      }
      const i4 = (y * w + x) * 4
      data[i4] = rr; data[i4 + 1] = gg; data[i4 + 2] = bb; data[i4 + 3] = aa
    }
  }
  const tex = new THREE.DataTexture(data, w, h)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  diag('ring DataTexture', w + 'x' + h, 'ready')
  return tex
}

// ---- base64 编解码（QuickJS 无 btoa/atob）+ readFileSync 重试（v1.0.7 冷启竞态加固） ----
const B64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const parts = []
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const has1 = i + 1 < len
    const has2 = i + 2 < len
    const b1 = has1 ? bytes[i + 1] : 0
    const b2 = has2 ? bytes[i + 2] : 0
    parts.push(
      B64_TABLE[b0 >> 2] +
      B64_TABLE[(b0 & 3) << 4 | b1 >> 4] +
      (has1 ? B64_TABLE[(b1 & 15) << 2 | b2 >> 6] : '=') +
      (has2 ? B64_TABLE[b2 & 63] : '='),
    )
  }
  return parts.join('')
}

function base64ToBytes(b64) {
  const clean = b64.slice(b64.indexOf(',') + 1).replace(/=+$/, '')
  const len = clean.length
  const out = new Uint8Array(Math.floor(len * 3 / 4))
  let o = 0
  for (let i = 0; i < len; i += 4) {
    const e0 = B64_TABLE.indexOf(clean[i])
    const e1 = B64_TABLE.indexOf(clean[i + 1])
    const e2 = i + 2 < len ? B64_TABLE.indexOf(clean[i + 2]) : -1
    const e3 = i + 3 < len ? B64_TABLE.indexOf(clean[i + 3]) : -1
    out[o++] = e0 << 2 | e1 >> 4
    if (e2 >= 0) out[o++] = e1 << 4 | e2 >> 2
    if (e3 >= 0) out[o++] = e2 << 6 | e3
  }
  return out.subarray(0, o)
}

/** readFileSync 带 -1/异常重试（3 次 × 300ms，解决包文件未就绪竞态）。
 *  enc: undefined=二进制(ArrayBuffer) 'utf8'=文本。onOk(data)/onFail(err) 必调其一。 */
function readFileSyncRetry(path, enc, onOk, onFail, attempt) {
  const n = attempt || 0
  let data = null
  let err = null
  try {
    data = enc === 'utf8'
      ? wx.getFileSystemManager().readFileSync(path, 'utf8')
      : wx.getFileSystemManager().readFileSync(path)
    const size = data && (data.byteLength || data.length) || 0
    if (size <= 0) {
      err = new Error('readFileSync returned -1/empty (' + size + ')')
      data = null
    }
  } catch (e) {
    err = e
  }
  if (data) {
    diag('readFileSync OK:', path, '->', (data.byteLength || data.length), 'bytes', n ? ('(retry ' + n + ')') : '')
    onOk(data)
    return
  }
  if (n + 1 < 3) {
    diag('readFileSync retry in 300ms:', path, '| attempt', n + 1, '|', err && err.message)
    setTimeout(() => readFileSyncRetry(path, enc, onOk, onFail, n + 1), 300)
  } else {
    diag('readFileSync FAILED after 3 tries:', path, '|', err && err.message)
    onFail(err || new Error('readFileSync failed'))
  }
}

// ============================================================
// createRenderer
// ============================================================
export function createRenderer(opts = {}) {
  const canvas = opts.canvas
  const cssW = opts.cssW
  const cssH = opts.cssH
  if (!canvas || !cssW || !cssH) throw new TypeError('createRenderer 需要 { canvas, cssW, cssH }')

  // 分辨率铁律（v1.0.9 黑屏教训）：禁止手动预设 canvas.width/height
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  const dpr = Math.min(opts.pixelRatio || 2, 3, 4096 / Math.max(cssW, cssH))
  renderer.setPixelRatio(dpr)
  renderer.setSize(cssW, cssH, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = EXPOSURE

  const scene = new THREE.Scene()
  const equirectTex = makeEquirectDataTexture()
  equirectTex.mapping = THREE.EquirectangularReflectionMapping
  equirectTex.colorSpace = THREE.SRGBColorSpace
  scene.environment = equirectTex // three 内部自动 PMREM
  if ('environmentIntensity' in scene) scene.environmentIntensity = ENV_INTENSITY
  scene.background = equirectTex
  scene.fog = new THREE.Fog(PAL.space, 26, 64)
  probeCanvasBridge()

  const aspect = cssW / cssH
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 300)
  camera.position.copy(CAM_POS)
  camera.lookAt(CAM_LOOK)

  // 光：IBL + 追尾主光（镜头侧）+ 行星光 + 冷轮廓光（无阴影）
  const key = new THREE.DirectionalLight(PAL.keyLight, 4.0)
  key.position.set(3.5, 7, 8)
  scene.add(key)
  const fill = new THREE.DirectionalLight(PAL.fillLight, 1.0)
  fill.position.set(-6, 3, 7)
  scene.add(fill)
  scene.add(new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 1.1))
  const rim = new THREE.DirectionalLight(PAL.rimLight, 2.4)
  rim.position.set(-5, -2, -9)
  scene.add(rim)

  // ---- 背景系 ----
  function makeStarLayer(count, zNear, zFar, spreadX, spreadY, size, opacity) {
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    let s = count * 977
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    const c = new THREE.Color()
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rand() - 0.5) * spreadX
      pos[i * 3 + 1] = (rand() - 0.5) * spreadY
      pos[i * 3 + 2] = zNear - rand() * (zNear - zFar)
      c.setHSL(0.52 + rand() * 0.16, 0.2 + rand() * 0.35, 0.5 + rand() * 0.45)
      col[i * 3] = c.r
      col[i * 3 + 1] = c.g
      col[i * 3 + 2] = c.b
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return new THREE.Points(geo, new THREE.PointsMaterial({
      size,
      vertexColors: true,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    }))
  }
  scene.add(makeStarLayer(380, -95, -34, 70, 44, 0.07, 0.75))
  scene.add(makeStarLayer(240, -40, -8, 50, 32, 0.11, 0.9))

  const flareTexWarm = makeFlareTexture('255,245,225', '255,205,140')
  const flareTexCool = makeFlareTexture('225,245,255', '130,200,255')
  let fs = 99
  const frand = () => {
    fs = (fs * 1103515245 + 12345) & 0x7fffffff
    return fs / 0x7fffffff
  }
  for (let i = 0; i < FLARE_COUNT; i++) {
    const warm = frand() < 0.45
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: warm ? flareTexWarm : flareTexCool,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }))
    sp.position.set((frand() - 0.5) * 30, 1.5 + frand() * 8, -36 - frand() * 22)
    sp.scale.setScalar(0.4 + frand() * 0.4)
    scene.add(sp)
  }

  // ---- 带环行星（远景视觉锚点，不受雾影响） ----
  const planet = new THREE.Group()
  planet.add(new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 48, 32),
    new THREE.MeshStandardMaterial({ map: makePlanetDataTexture(), roughness: 0.92, metalness: 0.02, fog: false }),
  ))
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(4.3, 7.0, 64),
    new THREE.MeshBasicMaterial({
      map: makeRingDataTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
      opacity: 0.9,
    }),
  )
  ring.rotation.x = Math.PI / 2 - 0.32
  ring.rotation.y = 0.28
  planet.add(ring)
  planet.position.set(-5.8, 5.6, -36)
  planet.rotation.y = 0.6
  scene.add(planet)

  // ---- 星尘拖线（LineSegments，头亮尾暗；速度接 eng.speed） ----
  function makeDustLayer(count, ringR0, ringR1, spreadY, zNear, zFar, speedMul, colorHex) {
    const pos = new Float32Array(count * 2 * 3)
    const col = new Float32Array(count * 2 * 3)
    const lens = new Float32Array(count)
    let s = count * 311
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    const head = new THREE.Color(colorHex)
    const tail = head.clone().multiplyScalar(0.12)
    for (let i = 0; i < count; i++) {
      // 环形分布：避开中道消失点（否则静帧交叠成蛛网）
      const ang = rand() * Math.PI * 2
      const r = ringR0 + rand() * (ringR1 - ringR0)
      const x = Math.cos(ang) * r
      const y = Math.sin(ang) * r * 0.62
      const z = zNear - rand() * (zNear - zFar)
      lens[i] = 0.35 + rand() * 0.6
      pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z
      pos[i * 6 + 3] = x; pos[i * 6 + 4] = y; pos[i * 6 + 5] = z - lens[i]
      col[i * 6] = head.r; col[i * 6 + 1] = head.g; col[i * 6 + 2] = head.b
      col[i * 6 + 3] = tail.r; col[i * 6 + 4] = tail.g; col[i * 6 + 5] = tail.b
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: DUST_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }))
    lines.userData = { speedMul, ringR0, ringR1, spreadY, zNear, zFar, posAttr: geo.attributes.position, lens }
    return lines
  }
  const dustNear = makeDustLayer(85, 1.3, 4.6, 3.6, 3.5, -52, DUST_SPEED_NEAR, PAL.dustNear)
  const dustFar = makeDustLayer(60, 1.8, 6.5, 4.8, 2.5, -62, DUST_SPEED_FAR, PAL.dustFar)
  scene.add(dustNear, dustFar)
  const dustLayers = [dustNear, dustFar]

  function updateDust(layer, rollSpeed, dt) {
    const { speedMul, ringR0, ringR1, zNear, zFar, posAttr, lens } = layer.userData
    const arr = posAttr.array
    const speed = Math.max(rollSpeed, 6) * speedMul
    const span = zNear - zFar
    for (let i = 0; i < arr.length; i += 6) {
      const idx = i / 6
      arr[i + 2] += speed * dt
      if (arr[i + 2] > zNear) {
        arr[i + 2] -= span + lens[idx]
        const ang = Math.random() * Math.PI * 2
        const r = ringR0 + Math.random() * (ringR1 - ringR0)
        arr[i] = Math.cos(ang) * r
        arr[i + 1] = Math.sin(ang) * r * 0.62
      }
      arr[i + 3] = arr[i]
      arr[i + 4] = arr[i + 1]
      arr[i + 5] = arr[i + 2] - lens[idx]
    }
    posAttr.needsUpdate = true
  }

  // ---- 小行星：6 个预生成变体几何（unit 半径）+ 对象池镜像 state ----
  const asteroidGeos = []
  const asteroidMats = [
    new THREE.MeshStandardMaterial({ color: PAL.asteroidIce, roughness: 0.85, metalness: 0.06, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: PAL.asteroidRock, roughness: 0.62, metalness: 0.38, flatShading: true }),
  ]
  for (let v = 0; v < 6; v++) {
    const geo = new THREE.IcosahedronGeometry(1, 2)
    const p = geo.attributes.position
    let s = v * 823 + 7
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    const dirs = []
    for (let i = 0; i < 5; i++) {
      const vec = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize()
      dirs.push({ v: vec, f: 1.6 + rand() * 2.2, amp: 0.10 + rand() * 0.22 })
    }
    const seen = new Map()
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const keyK = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`
      let k = seen.get(keyK)
      if (k === undefined) {
        const r = Math.sqrt(x * x + y * y + z * z) || 1
        let n = 0.82 + rand() * 0.36
        for (const d of dirs) {
          const dot = (x * d.v.x + y * d.v.y + z * d.v.z) / r
          n += Math.sin(dot * d.f * Math.PI) * d.amp * 0.32
        }
        k = Math.max(0.45, n)
        seen.set(keyK, k)
      }
      p.setXYZ(i, x * k, y * k, z * k)
    }
    geo.computeVertexNormals()
    asteroidGeos.push(geo)
  }
  const asteroidFree = []
  const asteroidUsed = []
  function getAsteroidMesh(i) {
    let m = asteroidFree.pop()
    if (!m) {
      m = new THREE.Mesh(asteroidGeos[i % asteroidGeos.length], asteroidMats[(i + 1) % 2])
      m.castShadow = false
      scene.add(m)
    }
    m.visible = true
    return m
  }
  function releaseAsteroids() {
    for (const m of asteroidUsed) m.visible = false
    asteroidFree.push(...asteroidUsed)
    asteroidUsed.length = 0
  }

  // ---- 晶体：单几何/材质 + 池（含 halo 子 sprite） ----
  const crystalGeo = new THREE.OctahedronGeometry(0.4, 0)
  const crystalMat = new THREE.MeshStandardMaterial({
    color: '#0d4a44',
    emissive: PAL.crystal,
    emissiveIntensity: 1.9,
    metalness: 0.15,
    roughness: 0.15,
  })
  const crystalHaloTex = makeGlowTexture('74,255,221')
  const crystalFree = []
  const crystalUsed = []
  function getCrystalMesh() {
    let m = crystalFree.pop()
    if (!m) {
      m = new THREE.Mesh(crystalGeo, crystalMat)
      m.scale.set(1, 1.7, 1)
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: crystalHaloTex,
        color: '#4affdd',
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }))
      halo.scale.setScalar(0.4 * 5.2)
      m.add(halo)
      scene.add(m)
    }
    m.visible = true
    return m
  }
  function releaseCrystals() {
    for (const m of crystalUsed) m.visible = false
    crystalFree.push(...crystalUsed)
    crystalUsed.length = 0
  }

  // ---- 飞船 ----
  const shipGroup = new THREE.Group()
  scene.add(shipGroup)
  const navLights = []
  const flames = []
  let shipReady = false
  const _bbox = new THREE.Box3()
  const _size = new THREE.Vector3()
  const _center = new THREE.Vector3()

  function onShipLoaded(ship) {
    let texDims = 'none'
    ship.traverse((o) => {
      if (o.isMesh) {
        o.geometry.computeVertexNormals()
        o.material = new THREE.MeshStandardMaterial({
          map: o.material.map || null,
          roughnessMap: o.material.map || null, // 涂装贴图兼粗糙度图 → 漆面层次
          color: '#e6edf3',
          metalness: 0.5,
          roughness: 0.55,
        })
        if (o.material.map) {
          o.material.map.anisotropy = 4
          o.material.roughnessMap.anisotropy = 4
          const img = o.material.map.image
          if (img && img.width) texDims = img.width + 'x' + img.height
        }
      }
    })
    diag('ship loaded; mesh tex dims:', texDims)
    _bbox.setFromObject(ship)
    _bbox.getSize(_size)
    _bbox.getCenter(_center)
    const sc = SHIP_LENGTH / _size.z
    ship.scale.setScalar(sc)
    ship.rotation.y = Math.PI // 鼻朝 -z（前进方向）
    ship.position.set(-_center.x * sc, -_center.y * sc, -_center.z * sc)
    shipGroup.add(ship)

    const halfW = (_size.x / 2) * sc
    const tailZ = (_size.z / 2) * sc
    const engineMat = new THREE.MeshStandardMaterial({
      color: '#12233a',
      emissive: PAL.engine,
      emissiveIntensity: 2.4,
      metalness: 0.6,
      roughness: 0.3,
    })
    const flameMat = new THREE.MeshBasicMaterial({
      color: PAL.flame,
      transparent: true,
      opacity: 0.44,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const coreMat = new THREE.MeshBasicMaterial({
      color: PAL.flameCore,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const glowTex = makeGlowTexture('80,200,255')
    const engGeo = new THREE.CylinderGeometry(0.1, 0.08, 0.09, 12)
    const flameGeo = new THREE.ConeGeometry(0.11, 1.5, 12, 1, true)
    const coreGeo = new THREE.ConeGeometry(0.05, 1.0, 8, 1, true)
    for (const dx of [-0.3, 0.3]) {
      const eng = new THREE.Mesh(engGeo, engineMat)
      eng.rotation.x = Math.PI / 2
      eng.position.set(dx, 0.02, tailZ - 0.4)
      shipGroup.add(eng)
      const flame = new THREE.Mesh(flameGeo, flameMat)
      flame.rotation.x = Math.PI / 2
      flame.position.set(dx, 0.02, tailZ - 0.6)
      shipGroup.add(flame)
      const core = new THREE.Mesh(coreGeo, coreMat)
      core.rotation.x = Math.PI / 2
      core.position.set(dx, 0.02, tailZ - 0.45)
      shipGroup.add(core)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex,
        color: '#57d8ff',
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }))
      glow.position.set(dx, 0.02, tailZ - 0.42)
      glow.scale.setScalar(0.6)
      shipGroup.add(glow)
      flames.push({ glow, flame })
    }
    // 翼尖航行灯：左红右绿，交错闪烁
    const navGeo = new THREE.SphereGeometry(0.035, 8, 8)
    for (const [dx, col, phase] of [[-halfW * 0.96, '#ff4048', 0], [halfW * 0.96, '#41ff78', Math.PI]]) {
      const nav = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: col, fog: false }))
      nav.position.set(dx, 0.06, tailZ - 0.62)
      shipGroup.add(nav)
      navLights.push({ mesh: nav, phase })
    }
    const engLight = new THREE.PointLight('#39c6ff', 2.6, 4.5, 2)
    engLight.position.set(0, 0, tailZ + 0.1)
    shipGroup.add(engLight)
    diag('ship mounted: scale', sc.toFixed(3), '| pos', ship.position.x.toFixed(2), ship.position.y.toFixed(2), ship.position.z.toFixed(2), '| texDims', texDims)
  }

/** 剥离 gltf 的贴图引用（保留材质名/颜色因子），返回计数 */
function stripGltfTextures(json) {
  const images = (json.images || []).length
  const textures = (json.textures || []).length
  delete json.images
  delete json.textures
  for (const m of json.materials || []) {
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture
      delete m.pbrMetallicRoughness.metallicRoughnessTexture
    }
    delete m.normalTexture
    delete m.occlusionTexture
    delete m.emissiveTexture
  }
  return { materials: (json.materials || []).length, images, textures }
}

/** 贴图手动回贴：appassets URL + wx.createImage（设备已验证的 img 通路）→ THREE.Texture
 *  parse onLoad 后按 mesh 挂 map；仅 wx 环境调用。image 失败 = 无贴图船（灯光显形兜底）。 */
function attachLivery(scene) {
  try {
    const image = wx.createImage()
    image.onload = () => {
      try {
        const tex = new THREE.Texture(image)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.flipY = false // glTF UV 约定
        tex.needsUpdate = true
        let n = 0
        scene.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material.map = tex
            o.material.roughnessMap = null // 粗糙度图不回贴（回贴用同一张会过糙）
            n++
          }
        })
        diag('livery attached to', n, 'mesh(es)')
      } catch (e) {
        diag('livery attach threw:', e && e.message)
      }
    }
    image.onerror = () => diag('livery image ERROR — ship stays untextured (lights still show it)')
    image.src = translateSrc('pkg:/assets/omen-texture.png')
  } catch (e) {
    diag('attachLivery threw:', e && e.message)
  }
}

  /** 程序化占位飞船（资产链全失败时的兜底，保证游戏可跑不黑屏） */
  function buildFallbackShip() {
    const g = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial({ color: '#9fb4c8', metalness: 0.8, roughness: 0.4 })
    const dark = new THREE.MeshStandardMaterial({ color: '#2a3542', metalness: 0.7, roughness: 0.35 })
    const add = (w, h, d, x, y, z, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
      mesh.position.set(x, y, z)
      g.add(mesh)
    }
    add(0.5, 0.28, 1.5, 0, 0, 0, mat) // 机身
    add(0.26, 0.2, 0.6, 0, 0.16, -0.5, dark) // 座舱
    add(1.9, 0.08, 0.5, 0, 0, 0.35, mat) // 主翼
    add(0.1, 0.3, 0.4, -0.9, 0.1, 0.45, dark)
    add(0.1, 0.3, 0.4, 0.9, 0.1, 0.45, dark)
    return g
  }

  let fallbackShipGroup = null
  function installFallbackShip() {
    diag('SHIP FALLBACK installed (procedural)')
    const g = buildFallbackShip()
    fallbackShipGroup = g
    shipGroup.add(g)
    shipReady = true
  }

  function loadShip() {
    // forceShipChain：opts.forceShipChain 或 globalThis.__STAR_DRIFT_FORCE_SHIP_CHAIN__
    // （0=自动 1=注入数据 2=wx pkg:/ 3=程序化占位；仿真器隔离测试设 3）
    const forced = Number(opts.forceShipChain || globalThis.__STAR_DRIFT_FORCE_SHIP_CHAIN__ || 0)
    diag('loadShip start; forcedChain =', forced || 'auto')

    const finish = (ship, tag) => {
      diag('ship ONLOAD:', tag, '| children:', ship.children.length)
      if (fallbackShipGroup) {
        diag('late real ship arrives -> remove fallback')
        shipGroup.remove(fallbackShipGroup)
        fallbackShipGroup = null
      }
      onShipLoaded(ship)
    }
    const fail = (tag, err) => {
      diag('SHIP LOAD FAIL:', tag, '|', err && (err.message || String(err)), '| stack:', err && err.stack ? String(err.stack).slice(0, 300) : '')
      if (!shipReady) installFallbackShip()
    }
    // 看门狗：链挂起（典型 = appassets 贴图 promise 永不落定）→ 4s 后兜底占位船
    const watchdog = setTimeout(() => {
      if (!shipReady) {
        diag('SHIP WATCHDOG fired (10s, likely texture promise hang) -> fallback')
        installFallbackShip()
      }
    }, 10000)

    const onLoad = (ship, tag) => {
      clearTimeout(watchdog)
      try {
        const bbox = new THREE.Box3().setFromObject(ship)
        const size = new THREE.Vector3()
        bbox.getSize(size)
        diag('ship parse OK:', tag, '| children:', ship.children.length,
          '| bbox:', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2))
        finish(ship, tag)
      } catch (e) {
        diag('ship finish threw:', e && e.message, '| stack:', e && e.stack ? String(e.stack).slice(0, 300) : '')
        if (!shipReady) installFallbackShip()
      }
    }
    const onErr = (tag) => (err) => {
      clearTimeout(watchdog)
      fail(tag, err)
    }

    // 链 1：浏览器 harness 注入（data URI 全内嵌，无 fetch）
    const injected = forced === 0 || forced === 1 ? globalThis.__STAR_DRIFT_SHIP_DATA__ : null
    if (injected) {
      diag('ship chain 1: injected data URI (harness)')
      try {
        new GLTFLoader().parse(JSON.stringify(injected), '',
          (gltf) => onLoad(gltf.scene, 'chain1'),
          onErr('chain1-parse'))
      } catch (e) {
        fail('chain1-sync', e)
      }
      return
    }
    // 链 2（v1.0.7 内联版，零外部 I/O）：
    // utf8 读 gltf → 剥离 images/textures/材质贴图引用（保留 baseColorFactor 颜色）
    // → bin 读出并 base64 内联 buffers[0].uri → GLTFLoader.parse 没有任何可挂起的资源 promise
    if (forced === 0 || forced === 2) {
      if (typeof globalThis.wx !== 'undefined' && globalThis.wx && globalThis.wx.getFileSystemManager) {
        diag('ship chain 2: inline (utf8 gltf + strip textures + bin data URI)')
        readFileSyncRetry('assets/omen.gltf', 'utf8', (gltfText) => {
          let json
          try {
            json = JSON.parse(gltfText)
          } catch (e) {
            fail('chain2-json', e)
            return
          }
          const counts = stripGltfTextures(json)
          diag('strip done: materials', counts.materials,
            '| removed images', counts.images, '| removed textures', counts.textures)
          readFileSyncRetry('assets/omen.bin', undefined, (binBuf) => {
            const b64 = bytesToBase64(binBuf)
            json.buffers[0].uri = 'data:application/octet-stream;base64,' + b64
            diag('bin inline: bytes', binBuf.byteLength, '| b64 len', b64.length)
            const t0 = Date.now()
            try {
              new GLTFLoader().parse(JSON.stringify(json), '', (gltf) => {
                diag('inline parse OK in', Date.now() - t0, 'ms')
                if (typeof globalThis.wx !== 'undefined' && globalThis.wx) {
                  attachLivery(gltf.scene) // 贴图手动回贴（appassets img 设备已验证）
                }
                clearTimeout(watchdog)
                onLoad(gltf.scene, 'chain2-inline')
              }, (err) => {
                diag('inline parse onError:', err && (err.message || err))
                fail('chain2-parse-async', err)
              })
            } catch (e) {
              diag('inline parse SYNC THROW:', e && (e.stack || e.message))
              fail('chain2-parse-sync', e)
            }
          }, (e) => fail('chain2-bin', e))
        }, (e) => fail('chain2-gltf', e))
        return
      } else {
        diag('chain2 skipped: no wx.getFileSystemManager')
      }
    } else {
      diag('chain2 skipped: forced =', forced)
    }
    // 链 3：程序化占位
    diag('ship chain 3: procedural fallback')
    onShipLoaded(buildFallbackShip())
  }
  loadShip()

  // ---- HUD（第二块 wx.createCanvas 2D → CanvasTexture；拿不到降级无 HUD 不崩） ----
  function makeHudCanvas() {
    try {
      if (typeof wx !== 'undefined' && wx && typeof wx.createCanvas === 'function') {
        const c = wx.createCanvas()
        if (c && c !== canvas && typeof c.getContext === 'function') return c
      }
    } catch (e) { /* fallthrough */ }
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        return document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas')
      }
    } catch (e) { /* fallthrough */ }
    return null
  }

  function makeHudLayer() {
    const cv = makeHudCanvas()
    if (!cv) return null
    cv.width = Math.round(cssW * 2)
    cv.height = Math.round(cssH * 2)
    const ctx = cv.getContext && cv.getContext('2d')
    if (!ctx) return null
    const tex = new THREE.CanvasTexture(cv)
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    const hscene = new THREE.Scene()
    const hcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2)
    hcam.position.z = 1
    hscene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
    ))
    return { cv, ctx, tex, scene: hscene, cam: hcam, lastKey: null }
  }
  const hud = makeHudLayer()

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  function drawText(ctx, str, x, y, font, color, align, blur, oy, alpha, glowColor, spacing) {
    ctx.globalAlpha = alpha == null ? 1 : alpha
    ctx.font = font
    ctx.fillStyle = color
    ctx.textAlign = align
    ctx.textBaseline = 'alphabetic'
    ctx.letterSpacing = spacing || '0px'
    ctx.shadowColor = glowColor || 'rgba(4,8,16,.6)'
    ctx.shadowBlur = blur
    ctx.shadowOffsetY = oy
    ctx.fillText(str, x, y)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.letterSpacing = '0px'
    ctx.globalAlpha = 1
  }

  function drawCorners(ctx, inset, len, color, lw) {
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    const x0 = inset
    const x1 = cssW - inset
    const y0 = inset
    const y1 = cssH - inset
    ctx.beginPath()
    ctx.moveTo(x0, y0 + len); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0)
    ctx.moveTo(x1 - len, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + len)
    ctx.moveTo(x1, y1 - len); ctx.lineTo(x1, y1); ctx.lineTo(x1 - len, y1)
    ctx.moveTo(x0 + len, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - len)
    ctx.stroke()
  }

  const FONT = '"PingFang SC", "Helvetica Neue", sans-serif'
  function drawHud(eng, st, nowMs) {
    if (!hud) return
    const W = cssW
    const H = cssH
    const locked = st.phase === 'dead' && st.deadMs >= (eng.deadLockMs != null ? eng.deadLockMs : 600)
    const blinkOn = Math.floor(nowMs / 450) % 2 === 0
    const key = [st.phase, st.score, st.best, locked ? 1 : 0, blinkOn ? 1 : 0, st.deathReason].join('|')
    if (key === hud.lastKey) return
    hud.lastKey = key
    const ctx = hud.ctx
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const CYAN = '#8fe3ff'
    drawCorners(ctx, 16, 26, 'rgba(127,231,255,.42)', 1.5)

    if (st.phase === 'ready') {
      drawText(ctx, 'S  T  A  R     D  R  I  F  T', W / 2, 262, `700 15px ${FONT}`, 'rgba(160,225,255,.95)', 'center', 8, 3, null, 'rgba(120,200,255,.5)')
      ctx.font = `900 68px ${FONT}`
      ctx.textAlign = 'center'
      ctx.shadowColor = 'rgba(90,190,255,.55)'
      ctx.shadowBlur = 26
      ctx.fillStyle = 'rgba(210,240,255,.4)'
      ctx.fillText('星际穿行', W / 2, 352)
      ctx.shadowColor = 'rgba(4,8,16,.65)'
      ctx.shadowBlur = 10
      ctx.shadowOffsetY = 6
      ctx.fillStyle = '#ffffff'
      ctx.fillText('星际穿行', W / 2, 352)
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
      ctx.textAlign = 'left'
      const label = '点按开始'
      ctx.font = `600 21px ${FONT}`
      ctx.letterSpacing = '2px'
      const tw = ctx.measureText(label).width
      ctx.letterSpacing = '0px'
      const pw = tw + 64
      const px = (W - pw) / 2
      const py = 430
      const ph = 56
      ctx.fillStyle = 'rgba(8,14,24,.45)'
      rr(ctx, px, py, pw, ph, 28)
      ctx.fill()
      ctx.shadowColor = 'rgba(80,200,255,.6)'
      ctx.shadowBlur = 14
      ctx.strokeStyle = 'rgba(150,230,255,.95)'
      ctx.lineWidth = 2.5
      rr(ctx, px, py, pw, ph, 28)
      ctx.stroke()
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      drawText(ctx, label, W / 2, py + 36, `600 21px ${FONT}`, '#ffffff', 'center', 6, 2, null, 'rgba(120,220,255,.5)', '2px')
    } else {
      if (st.phase === 'dead') {
        ctx.fillStyle = 'rgba(10,14,22,.28)'
        ctx.fillRect(0, 0, W, H)
      }
      const dist = typeof eng.distance === 'number' && isFinite(eng.distance) ? eng.distance : st.score
      const distStr = String(Math.max(0, Math.floor(dist)))
      // 左上 DIST
      drawText(ctx, 'DIST', 30, 56, `600 12px ${FONT}`, 'rgba(143,227,255,.9)', 'left', 4, 2, null, null, '3px')
      ctx.font = `800 46px ${FONT}`
      const dw = ctx.measureText(distStr).width
      ctx.letterSpacing = '1px'
      ctx.shadowColor = 'rgba(120,225,255,.65)'
      ctx.shadowBlur = 16
      ctx.fillStyle = 'rgba(210,245,255,.55)'
      ctx.fillText(distStr, 30, 102)
      ctx.shadowColor = 'rgba(4,8,16,.6)'
      ctx.shadowBlur = 5
      ctx.shadowOffsetY = 3
      ctx.fillStyle = '#ffffff'
      ctx.fillText(distStr, 30, 102)
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
      ctx.letterSpacing = '0px'
      drawText(ctx, 'm', 30 + dw + 14, 102, `600 19px ${FONT}`, 'rgba(143,227,255,.8)', 'left', 4, 2)
      // 右上 BEST
      drawText(ctx, 'BEST', W - 30, 56, `600 12px ${FONT}`, 'rgba(143,227,255,.9)', 'right', 4, 2, null, null, '3px')
      drawText(ctx, 'm', W - 30, 96, `600 15px ${FONT}`, 'rgba(143,227,255,.8)', 'right', 4, 2)
      ctx.font = `800 30px ${FONT}`
      ctx.shadowColor = 'rgba(120,225,255,.55)'
      ctx.shadowBlur = 12
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'right'
      ctx.fillText(String(st.best), W - 48, 96)
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.textAlign = 'left'
      // 晶体数（score - floor(dist) 反推，避免引擎加字段）
      const crystalsRun = Math.max(0, Math.round((st.score - dist) / 50))
      const cx = W - 30 - 46
      const cy = 130
      ctx.save()
      ctx.translate(cx, cy - 7)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = 'rgba(46,242,207,.28)'
      ctx.strokeStyle = 'rgba(127,255,235,.95)'
      ctx.lineWidth = 1.6
      ctx.shadowColor = 'rgba(46,242,207,.9)'
      ctx.shadowBlur = 9
      rr(ctx, -7, -7, 14, 14, 2.5)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
      drawText(ctx, '× ' + crystalsRun, W - 30, cy, `700 20px ${FONT}`, '#a5ffec', 'right', 8, 2, null, 'rgba(46,242,207,.6)')
      // 提示条 / 重开提示
      if (st.phase === 'playing') {
        const label = '拖拽躲避 · 收集晶体'
        ctx.font = `500 15px ${FONT}`
        ctx.letterSpacing = '1px'
        const tw = ctx.measureText(label).width
        ctx.letterSpacing = '0px'
        const pw = tw + 44
        const ph = 40
        const px = (W - pw) / 2
        const py = H - 62
        ctx.fillStyle = 'rgba(8,14,24,.55)'
        rr(ctx, px, py, pw, ph, 20)
        ctx.fill()
        ctx.strokeStyle = 'rgba(127,231,255,.55)'
        ctx.lineWidth = 1.2
        rr(ctx, px, py, pw, ph, 20)
        ctx.stroke()
        drawText(ctx, label, W / 2, py + 26, `500 15px ${FONT}`, '#eaf6ff', 'center', 4, 2, null, null, '1px')
      } else if (locked) {
        const msg = st.deathReason === 'asteroid' ? '撞上小行星 · 点按重开' : '点按重开'
        drawText(ctx, msg, W / 2, H / 2 + 60, `600 17px ${FONT}`, '#ffffff', 'center', 8, 3, blinkOn ? 1 : 0.35, 'rgba(120,220,255,.5)', '2px')
      }
    }
    hud.tex.needsUpdate = true
  }

  // ---- 每帧同步 ----
  let lastMs = 0
  let lastPhase = null
  let deathT = -1 // 死亡表现计时（-1 = 非死亡态）
  const _camTarget = new THREE.Vector3()
  const _look = new THREE.Vector3()

  function syncWorld(st, dt) {
    // 小行星：池镜像（引擎已做回收，渲染层只按 state 摆）
    releaseAsteroids()
    for (let i = 0; i < st.asteroids.length; i++) {
      const a = st.asteroids[i]
      const m = getAsteroidMesh(i)
      m.position.set(a.x, 0, a.z)
      m.scale.setScalar(a.r)
      m.rotation.y += a.spin * dt
      m.rotation.x += a.spin * 0.6 * dt
      asteroidUsed.push(m)
    }
    // 晶体
    releaseCrystals()
    for (const c of st.crystals) {
      const m = getCrystalMesh()
      m.position.set(c.x, 0.15 + Math.sin(nowMsRef * 0.002 + c.x * 2) * 0.06, c.z)
      m.rotation.y = nowMsRef * 0.0025 + c.x
      crystalUsed.push(m)
    }
  }

  function syncShip(st, dt, nowMs) {
    const p = st.player
    shipGroup.position.set(p.x, Math.sin(nowMs * 0.0016) * 0.06, 0)
    // 横移倾斜：x 与 targetX 差值 → 侧倾 + 偏航（右移 dxT<0 → roll/yaw 变负 = 右倾机头朝右）
    const dxT = p.x - p.targetX
    let targetRoll = dxT * 0.35
    let targetYaw = dxT * 0.4 + 0.06
    if (st.phase === 'dead') {
      // 死亡表现：侧倾翻滚 + 缓慢偏航漂移
      targetRoll = Math.min(0.9, deathT * 2.4)
      targetYaw = deathT * 1.6 + 0.06
      if (deathT >= 0) deathT += dt
    } else if (st.phase === 'ready') {
      targetRoll = 0
      targetYaw = 0.06
    }
    const k = 1 - Math.exp(-(dt || 0.016) * 10)
    shipGroup.rotation.z += (THREE.MathUtils.clamp(targetRoll, -0.45, 0.45) - shipGroup.rotation.z) * k
    shipGroup.rotation.y += (THREE.MathUtils.clamp(targetYaw, -1.5, 1.5) - shipGroup.rotation.y) * k
    shipGroup.rotation.x += (Math.sin(nowMs * 0.0009) * 0.025 - shipGroup.rotation.x) * k
    for (const { mesh, phase } of navLights) mesh.visible = Math.sin(nowMs * 0.0042 + phase) > -0.2
    for (const f of flames) {
      f.glow.material.opacity = 0.55 + Math.sin(nowMs * 0.0093) * 0.15
      f.glow.scale.setScalar(0.62 + Math.sin(nowMs * 0.0117) * 0.1)
    }
  }

  function updateCamera(st, dt) {
    _camTarget.set(st.player.x * CAM_PARALLAX, 1.25 + Math.sin(st.player.x * 0.5) * 0.04, CAM_POS.z)
    const k = 1 - Math.exp(-(dt || 0.016) * 6)
    camera.position.x += (_camTarget.x - camera.position.x) * k
    camera.position.y += (_camTarget.y - camera.position.y) * k
    _look.set(st.player.x * CAM_PARALLAX, CAM_LOOK.y, CAM_LOOK.z)
    camera.lookAt(_look)
  }

  let nowMsRef = 0
  const view = {
    renderer,
    /** 每帧渲染（shell 的 canvas.requestAnimationFrame 循环里调用）。nowMs 毫秒时间戳。 */
    render(eng, nowMs) {
      const st = eng.getState()
      const dt = lastMs ? Math.min(Math.max((nowMs - lastMs) / 1000, 0), 0.1) : 0.016
      nowMsRef = nowMs || 0
      const phaseChanged = st.phase !== lastPhase
      if (phaseChanged) {
        if (lastPhase === 'dead') {
          // 重开：世界重建（引擎 rng 连续流，行内容已换）——清池重镜像即可
          releaseAsteroids()
          releaseCrystals()
        }
        if (st.phase === 'dead') deathT = 0
        else deathT = -1
        if (hud) hud.lastKey = null
      }
      syncWorld(st, dt)
      syncShip(st, dt, nowMsRef)
      updateCamera(st, dt)
      updateDust(dustNear, st.speed || 18, dt)
      updateDust(dustFar, st.speed || 18, dt)
      drawHud(eng, st, nowMs || 0)
      lastMs = nowMs || 0
      lastPhase = st.phase
      renderer.render(scene, camera)
      if (hud) {
        renderer.autoClear = false
        renderer.render(hud.scene, hud.cam)
        renderer.autoClear = true
      }
    },
    /** 主题钩子：壳层 try/catch 调用；当前拍板视觉为深空浅字，dark 预留不崩 */
    setThemeMode(mode) {
      return mode
    },
  }
  return view
}

export default createRenderer
