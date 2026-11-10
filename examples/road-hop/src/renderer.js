/**
 * Road Hop · 渲染层（M2）
 *
 * 职责：读 eng.getState() 纯数据 → 同步进 three 场景 → renderer.render。
 * 不持有玩法逻辑；不碰 canvas.width/height（分辨率铁律在 createRenderer 内部执行）。
 *
 * 对齐契约（engine.js v1）：
 *   state.phase 'ready'|'playing'|'dead'；player.x/z 连续坐标；tween.p∈[0,1]
 *   跳跃弧高 = tween.p × HOP_ARC_HEIGHT × sin(π·p)（纯视觉）
 *   rows: grass {index,type,trees:col[]} / road {index,type,dir,speed,cars:[{x}]}
 *   cars[i].x 直接摆（不做 clamp，环形车道回绕）；row.dir +1 → 车头 +x，-1 → rotation.y=π
 *   dead 重开提示读 eng.deadMs ≥ eng.deadLockMs（不硬编码 600）
 *
 * 性能（真机约束）：
 *   - 全场景顶点色合并几何：每行 1~2 个 mesh（地面 / 树）、每车 1 个 mesh、小鸡 1 个，
 *     共享一个 MeshLambertMaterial；典型在屏对象 ~60 个（窗口 29 行 + 车 ~25 + 小鸡 + HUD）。
 *   - 几何缓存按内容 key 复用（草地/马路/树形/车色板），引用计数归零才 dispose。
 *   - HUD：第二块 wx.createCanvas()（拿不到则降级为无 HUD）画 2D，CanvasTexture 贴回唯一
 *     WebGL canvas；只在内容变化时重绘（blink 按 450ms 分桶）。
 *
 * 相机（M1 预览定稿，用户已拍板）：
 *   OrthographicCamera 半宽 5（竖屏可见 ~10 列）；偏移 (2.2,13,7.6)；
 *   focus 沿屏幕上方地面方向 (-0.279,0,-0.960)×4.31 前移 → 玩家居中、屏幕下 1/3。
 *   原理依据见 constants.js VIEW_ROWS_* 注释。
 */
import * as THREE from 'three'
import { HOP_ARC_HEIGHT } from './constants.js'

// ---- 视觉常量（M1 拍板稿色板，禁止随手改） ----
const PAL = {
  grassA: '#aad751',
  grassB: '#a2d249',
  road: '#454a52',
  dash: '#f4f5f7',
  trunk: '#8a5a32',
  leaf: '#3e8948',
  cars: ['#e5533d', '#3d88e5', '#e5c53d', '#7a4dd6'],
  glass: '#222e3b',
  wheel: '#171a20',
  chick: '#f7f4ec',
  comb: '#d6402e',
  beak: '#e8952f',
  eye: '#20242b',
  headlight: '#fff3c4',
  taillight: '#7e1f1a',
  fog: '#c9e598',
}

const CAM_OFF = new THREE.Vector3(2.2, 13, 7.6)
const UP_G = new THREE.Vector3(-0.279, 0, -0.960) // 屏幕上方地面方向（three 空间）
const FOCUS_LEAD = 4.31
const HALF_W = 5 // 正交半宽：可见 ~10 列
const SUN_OFF = new THREE.Vector3(10, 16, 8)
const SUN_TGT = new THREE.Vector3(0, 0, -7)
const SLAB_W = 24 // 地表条宽度（覆盖正交视野斜角）
const FOG_NEAR = 19
const FOG_FAR = 26
const CAM_BAND_BACK = 14 // 相机行带（自 focus 起算；玩家后方可见 ~8.7 行 + focus 超前 4.14 行 → ≥13，取 14）
const CAM_BAND_AHEAD = 17 // 相机行带（玩家前方；实测可见 ~17.7 行）
const HUD_SCALE = 2
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif'

// ============================================================
// 顶点色合并几何：把一组盒子 bake 成一个 BufferGeometry
// specs: { w,h,d, x,y,z, c(color hex) }[]
// ============================================================
function mergedBoxGeometry(specs) {
  const pos = []
  const nor = []
  const col = []
  const color = new THREE.Color()
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const g = new THREE.BoxGeometry(s.w, s.h, s.d).toNonIndexed()
    g.translate(s.x, s.y, s.z)
    color.set(s.c)
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

// ---- 体素拼装 spec（与 M1 拍板稿一致） ----

/** 小鸡（面朝 -z；红冠/橙喙/肉垂/黑眼） */
function chickenSpecs() {
  return [
    { w: 0.14, h: 0.14, d: 0.16, x: -0.12, y: 0.07, z: 0.06, c: PAL.beak },
    { w: 0.14, h: 0.14, d: 0.16, x: 0.12, y: 0.07, z: 0.06, c: PAL.beak },
    { w: 0.46, h: 0.42, d: 0.58, x: 0, y: 0.35, z: 0.02, c: PAL.chick },
    { w: 0.16, h: 0.2, d: 0.14, x: 0, y: 0.46, z: 0.34, c: PAL.chick },
    { w: 0.34, h: 0.32, d: 0.3, x: 0, y: 0.7, z: -0.08, c: PAL.chick },
    { w: 0.12, h: 0.16, d: 0.2, x: 0, y: 0.93, z: -0.08, c: PAL.comb },
    { w: 0.14, h: 0.09, d: 0.13, x: 0, y: 0.68, z: -0.29, c: PAL.beak },
    { w: 0.08, h: 0.1, d: 0.08, x: 0, y: 0.58, z: -0.26, c: PAL.comb },
    { w: 0.05, h: 0.07, d: 0.07, x: -0.175, y: 0.74, z: -0.12, c: PAL.eye },
    { w: 0.05, h: 0.07, d: 0.07, x: 0.175, y: 0.74, z: -0.12, c: PAL.eye },
  ]
}

/** 车（面朝 +x；车轮/车身/玻璃带/车顶/头尾灯） */
function carSpecs(ci) {
  const body = PAL.cars[ci % PAL.cars.length]
  return [
    { w: 0.3, h: 0.22, d: 0.14, x: -0.48, y: 0.11, z: 0.36, c: PAL.wheel },
    { w: 0.3, h: 0.22, d: 0.14, x: 0.48, y: 0.11, z: 0.36, c: PAL.wheel },
    { w: 0.3, h: 0.22, d: 0.14, x: -0.48, y: 0.11, z: -0.36, c: PAL.wheel },
    { w: 0.3, h: 0.22, d: 0.14, x: 0.48, y: 0.11, z: -0.36, c: PAL.wheel },
    { w: 1.5, h: 0.4, d: 0.82, x: 0, y: 0.4, z: 0, c: body },
    { w: 0.78, h: 0.3, d: 0.74, x: 0.12, y: 0.73, z: 0, c: PAL.glass },
    { w: 0.9, h: 0.09, d: 0.8, x: 0.15, y: 0.92, z: 0, c: body },
    { w: 0.08, h: 0.1, d: 0.16, x: 0.74, y: 0.42, z: 0.24, c: PAL.headlight },
    { w: 0.08, h: 0.1, d: 0.16, x: 0.74, y: 0.42, z: -0.24, c: PAL.headlight },
    { w: 0.07, h: 0.09, d: 0.14, x: -0.72, y: 0.42, z: 0.24, c: PAL.taillight },
    { w: 0.07, h: 0.09, d: 0.14, x: -0.72, y: 0.42, z: -0.24, c: PAL.taillight },
  ]
}

/** 树（干 + 双层冠） */
function treeSpecs(col) {
  return [
    { w: 0.3, h: 0.55, d: 0.3, x: col, y: 0.27, z: 0, c: PAL.trunk },
    { w: 0.95, h: 0.62, d: 0.95, x: col, y: 0.82, z: 0, c: PAL.leaf },
    { w: 0.62, h: 0.52, d: 0.62, x: col, y: 1.36, z: 0, c: PAL.leaf },
  ]
}

/** 行地面（草双色 / 马路 + 组内白虚线） */
function rowGroundSpecs(type, parity, dashes) {
  const specs = [{
    w: SLAB_W, h: 0.35, d: 1, x: 0, y: -0.175, z: 0,
    c: type === 'grass' ? (parity === 0 ? PAL.grassA : PAL.grassB) : PAL.road,
  }]
  if (dashes) {
    for (let i = -5; i <= 5; i++) {
      specs.push({ w: 0.7, h: 0.05, d: 0.1, x: i * 1.5, y: 0.026, z: -0.5, c: PAL.dash })
    }
  }
  return specs
}

// ============================================================
// createRenderer
// ============================================================
export function createRenderer(opts = {}) {
  const canvas = opts.canvas
  const cssW = opts.cssW
  const cssH = opts.cssH
  if (!canvas || !cssW || !cssH) throw new TypeError('createRenderer 需要 { canvas, cssW, cssH }')

  // 分辨率铁律（v1.0.9 黑屏教训）：禁止手动预设 canvas.width/height；
  // dpr = min(pixelRatio, 3, 4096/max(cssW,cssH)) → setPixelRatio → setSize(cssW,cssH,false)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  const dpr = Math.min(opts.pixelRatio || 2, 3, 4096 / Math.max(cssW, cssH))
  renderer.setPixelRatio(dpr)
  renderer.setSize(cssW, cssH, false)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  // ---- 场景 / 相机 / 光 ----
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(PAL.fog)
  scene.fog = new THREE.Fog(PAL.fog, FOG_NEAR, FOG_FAR)

  const aspect = cssW / cssH
  const halfH = HALF_W / aspect
  const camera = new THREE.OrthographicCamera(-HALF_W, HALF_W, halfH, -halfH, 0.5, 120)

  scene.add(new THREE.HemisphereLight('#eaf6ff', '#6e8b52', 0.95))
  const sun = new THREE.DirectionalLight('#fff3dd', 1.0)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -15
  sun.shadow.camera.right = 15
  sun.shadow.camera.top = 30
  sun.shadow.camera.bottom = -30
  sun.shadow.camera.near = 4
  sun.shadow.camera.far = 60
  sun.shadow.bias = -0.0006
  if ('normalBias' in sun.shadow) sun.shadow.normalBias = 0.02
  scene.add(sun)
  scene.add(sun.target)

  const worldMat = new THREE.MeshLambertMaterial({ vertexColors: true })

  // ---- 几何缓存（内容 key → {geo, refs}；refs 归零即 dispose） ----
  const geoCache = new Map()
  function obtainGeo(key, makeSpecs) {
    let e = geoCache.get(key)
    if (!e) {
      e = { key, geo: mergedBoxGeometry(makeSpecs()), refs: 0 }
      geoCache.set(key, e)
    }
    e.refs++
    return e
  }
  function releaseGeo(entry) {
    if (!entry) return
    entry.refs--
    if (entry.refs <= 0) {
      geoCache.delete(entry.key)
      entry.geo.dispose()
    }
  }

  // ---- 世界行仓库 ----
  // index → { data, ground, props, groundGeo, propsGeo, cars: Map(j → mesh), synth, built }
  const store = new Map()
  const carPool = new Map() // colorIdx → mesh[]
  const carGeoCache = PAL.cars.map((_, ci) => obtainGeo(`car|${ci}`, () => carSpecs(ci)))

  function makeMesh(geoEntry) {
    const m = new THREE.Mesh(geoEntry.geo, worldMat)
    m.userData.geoEntry = geoEntry
    return m
  }

  function disposeMesh(m) {
    if (!m) return
    scene.remove(m)
    releaseGeo(m.userData.geoEntry)
  }

  function getCarMesh(ci) {
    let pool = carPool.get(ci)
    if (!pool) {
      pool = []
      carPool.set(ci, pool)
    }
    let m = pool.pop()
    if (!m) m = makeMesh(carGeoCache[ci])
    scene.add(m)
    return m
  }

  function releaseCarMesh(ci, m) {
    scene.remove(m)
    let pool = carPool.get(ci)
    if (!pool) {
      pool = []
      carPool.set(ci, pool)
    }
    pool.push(m)
  }

  function buildRow(entry, nextIsRoad) {
    disposeMesh(entry.ground)
    disposeMesh(entry.props)
    entry.ground = null
    entry.props = null
    entry.groundGeo = null
    entry.propsGeo = null

    const d = entry.data
    const parity = ((d.index % 2) + 2) % 2
    const isRoad = d.type === 'road'
    const groundKey = isRoad ? `R|${nextIsRoad ? 1 : 0}` : `G|${parity}`
    entry.groundGeo = obtainGeo(groundKey, () => rowGroundSpecs(d.type, parity, isRoad && nextIsRoad))
    entry.ground = makeMesh(entry.groundGeo)
    entry.ground.position.z = -d.index
    entry.ground.receiveShadow = true
    scene.add(entry.ground)

    const trees = isRoad ? [] : d.trees || []
    if (trees.length > 0) {
      entry.propsGeo = obtainGeo(`T|${trees.join(',')}`, () => {
        const specs = []
        for (const col of trees) specs.push(...treeSpecs(col))
        return specs
      })
      entry.props = makeMesh(entry.propsGeo)
      entry.props.position.z = -d.index
      entry.props.castShadow = true
      entry.props.receiveShadow = true
      scene.add(entry.props)
    }
    entry.built = true
  }

  function disposeEntry(entry) {
    disposeMesh(entry.ground)
    disposeMesh(entry.props)
    entry.ground = null
    entry.props = null
    entry.groundGeo = null
    entry.propsGeo = null
    if (entry.cars) {
      for (const m of entry.cars.values()) {
        const ci = m.userData.colorIdx
        scene.remove(m)
        let pool = carPool.get(ci)
        if (!pool) {
          pool = []
          carPool.set(ci, pool)
        }
        pool.push(m)
      }
      entry.cars.clear()
    }
    entry.built = false
  }

  // ---- 小鸡 ----
  const chicken = new THREE.Mesh(obtainGeo('chicken', chickenSpecs).geo, worldMat)
  chicken.castShadow = true
  scene.add(chicken)

  // ---- HUD（离屏 canvas → CanvasTexture → 全屏 quad） ----
  function makeHudCanvas() {
    try {
      if (typeof wx !== 'undefined' && wx && typeof wx.createCanvas === 'function') {
        const c = wx.createCanvas()
        if (c && c !== canvas && typeof c.getContext === 'function') return c
      }
    } catch (e) { /* fallthrough */ }
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        return document.createElement('canvas')
      }
    } catch (e) { /* fallthrough */ }
    return null
  }

  function makeHudLayer() {
    const cv = makeHudCanvas()
    if (!cv) return null
    cv.width = Math.round(cssW * HUD_SCALE)
    cv.height = Math.round(cssH * HUD_SCALE)
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
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
    )
    hscene.add(quad)
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

  function pill(ctx, cx, cy, label, font, alpha) {
    ctx.font = font
    const tw = ctx.measureText(label).width
    const pw = tw + 42
    const ph = 40
    const px = cx - pw / 2
    const py = cy
    ctx.globalAlpha = alpha
    ctx.fillStyle = 'rgba(12,16,24,.5)'
    rr(ctx, px, py, pw, ph, 20)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = 'rgba(10,14,22,.45)'
    ctx.shadowBlur = 4
    ctx.shadowOffsetY = 2
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(label, cx, py + 26)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.globalAlpha = 1
  }

  function drawText(ctx, str, x, y, font, color, align, blur, oy, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha
    ctx.font = font
    ctx.fillStyle = color
    ctx.textAlign = align
    ctx.textBaseline = 'alphabetic'
    ctx.shadowColor = 'rgba(10,14,22,.45)'
    ctx.shadowBlur = blur
    ctx.shadowOffsetY = oy
    ctx.fillText(str, x, y)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.globalAlpha = 1
  }

  function drawHud(eng, st, nowMs) {
    if (!hud) return
    const W = cssW
    const H = cssH
    const deadLock = eng.deadLockMs != null ? eng.deadLockMs : 600
    const locked = st.phase === 'dead' && st.deadMs >= deadLock
    const blinkOn = Math.floor(nowMs / 450) % 2 === 0
    const key = [st.phase, st.score, st.best, locked ? 1 : 0, blinkOn ? 1 : 0, st.deathReason].join('|')
    if (key === hud.lastKey) return
    hud.lastKey = key

    const ctx = hud.ctx
    ctx.setTransform(HUD_SCALE, 0, 0, HUD_SCALE, 0, 0)
    ctx.clearRect(0, 0, W, H)

    if (st.phase === 'ready') {
      // 大标题（M1 拍板稿版式）
      drawText(ctx, 'R  O  A  D     H  O  P', W / 2, 318 - 50, `700 15px ${FONT}`, 'rgba(255,255,255,.9)', 'center', 5, 3)
      drawText(ctx, '过马路', W / 2, 402 - 50, `900 68px ${FONT}`, '#ffffff', 'center', 14, 7, null)
      pill(ctx, W / 2, 548 - 50, '点按开始', `600 21px ${FONT}`, blinkOn ? 1 : 0.35)
    } else {
      if (st.phase === 'dead') {
        ctx.fillStyle = 'rgba(10,14,22,.28)'
        ctx.fillRect(0, 0, W, H)
      }
      // 左上 SCORE / 右上 BEST
      drawText(ctx, 'SCORE', 26, 54, `600 13px ${FONT}`, 'rgba(255,255,255,.85)', 'left', 4, 2)
      drawText(ctx, String(st.score), 26, 100, `800 46px ${FONT}`, '#ffffff', 'left', 8, 4)
      drawText(ctx, 'BEST', W - 26, 54, `600 13px ${FONT}`, 'rgba(255,255,255,.85)', 'right', 4, 2)
      drawText(ctx, String(st.best), W - 26, 94, `800 32px ${FONT}`, '#ffffff', 'right', 6, 3)
      if (st.phase === 'playing') {
        pill(ctx, W / 2, H - 64, '点按跳 · 左右滑变道', `500 15px ${FONT}`, 1)
      } else if (locked) {
        const msg = st.deathReason === 'crow' ? '被乌鸦带走了 · 点按重开' : '被撞扁了 · 点按重开'
        pill(ctx, W / 2, H / 2 + 60, msg, `600 17px ${FONT}`, blinkOn ? 1 : 0.35)
      }
    }
    hud.tex.needsUpdate = true
  }

  // ---- 每帧同步 ----
  const _focus = new THREE.Vector3(0, 0, 0)
  const _target = new THREE.Vector3()
  let camSnapped = false
  let lastMs = 0
  let lastPhase = null

  /** 行内容签名：同 index 但签名不同 ⇒ 引擎重建了世界（reset 不重播种，新世界行类型会变） */
  function rowSignature(r) {
    if (r.type === 'grass') return `g|${(r.trees || []).join(',')}`
    return `r|${r.dir}|${(r.cars || []).length}`
  }

  function syncWorld(st) {
    // 0) 世界重建检测：任一已建行的签名与 state 不符 ⇒ 全部推倒重建
    //    （eng.reset() 可从 playing/dead 任意态直接调，不能只靠 phase 转移检测）
    for (const r of st.rows) {
      const e = store.get(r.index)
      if (e && !e.synth && e.built && rowSignature(e.data) !== rowSignature(r)) {
        resetVisuals()
        break
      }
    }
    // 1) 状态行合入仓库（首次出现→建；合成行→被真实数据替换）
    for (const r of st.rows) {
      let e = store.get(r.index)
      if (!e) {
        store.set(r.index, { data: r, ground: null, props: null, groundGeo: null, propsGeo: null, cars: new Map(), synth: false, built: false })
      } else if (e.synth) {
        e.data = r
        e.synth = false
        e.built = false
      }
    }
    // 2) 相机行带
    const focusRow = -_focus.z
    const band0 = Math.floor(focusRow - CAM_BAND_BACK)
    const band1 = Math.ceil(focusRow + CAM_BAND_AHEAD)
    // 3) 带内缺失行 → 纯草地兜底（row<0 出生带 / 窗口异常时的安全网）
    for (let i = band0; i <= band1; i++) {
      if (i >= 0) continue
      if (!store.has(i)) {
        store.set(i, { data: { index: i, type: 'grass', trees: [] }, ground: null, props: null, groundGeo: null, propsGeo: null, cars: new Map(), synth: true, built: false })
      }
    }
    // 4) 建未建的行（nextIsRoad 用于组内虚线）
    for (let i = band0; i <= band1; i++) {
      const e = store.get(i)
      if (!e || e.built) continue
      const next = store.get(i + 1)
      buildRow(e, !!(next && next.data && next.data.type === 'road'))
    }
    // 5) 清理带外行
    for (const [i, e] of store) {
      if (i < band0 - 1 || i > band1 + 1) {
        disposeEntry(e)
        store.delete(i)
      }
    }
    // 6) 车辆位置（车连续移动，每帧按 state 直接摆）
    for (const r of st.rows) {
      if (r.type !== 'road') continue
      const e = store.get(r.index)
      if (!e || !e.built) continue
      const dirRot = r.dir === 1 ? 0 : Math.PI
      for (let j = 0; j < r.cars.length; j++) {
        const key = `${r.index}:${j}`
        let m = e.cars.get(key)
        if (!m) {
          const ci = ((r.index * 31 + j * 7) % 4 + 4) % 4
          m = getCarMesh(ci)
          m.userData.colorIdx = ci
          m.rotation.y = dirRot
          m.castShadow = true
          m.receiveShadow = true
          m.position.set(0, 0, -r.index)
          e.cars.set(key, m)
        }
        m.position.x = r.cars[j].x
      }
    }
  }

  function syncChicken(st, dt, nowMs) {
    const p = st.player
    let y = 0
    const tw = p.tween
    if (tw) {
      const t = Math.min(Math.max(tw.p, 0), 1)
      y = HOP_ARC_HEIGHT * t * Math.sin(Math.PI * t)
      const dRow = tw.toRow - tw.fromRow
      const dCol = tw.toCol - tw.fromCol
      if (dRow > 0) chicken.rotation.y = 0
      else if (dRow < 0) chicken.rotation.y = Math.PI
      else if (dCol > 0) chicken.rotation.y = -Math.PI / 2
      else if (dCol < 0) chicken.rotation.y = Math.PI / 2
    }
    chicken.position.set(p.x, y, -p.z)

    // 死亡表现：car → 撞扁；crow → 倾倒。活着回弹。
    let sy = 1
    let sxz = 1
    let tilt = 0
    if (st.phase === 'dead') {
      if (st.deathReason === 'crow') {
        sy = 0.85
        tilt = Math.PI / 2
      } else {
        sy = 0.32
        sxz = 1.18
      }
    } else if (st.phase === 'ready') {
      sy = 1 + 0.03 * Math.sin(nowMs * 0.004) // 待机呼吸
    }
    const k = 1 - Math.exp(-(dt || 0.016) * 12)
    chicken.scale.y += (sy - chicken.scale.y) * k
    chicken.scale.x += (sxz - chicken.scale.x) * k
    chicken.scale.z += (sxz - chicken.scale.z) * k
    chicken.rotation.z += (tilt - chicken.rotation.z) * k
  }

  function updateCamera(st, dt, snap) {
    _target.set(st.player.x, 0, -st.player.z).addScaledVector(UP_G, FOCUS_LEAD)
    if (snap || !camSnapped || _focus.distanceTo(_target) > 4) {
      _focus.copy(_target)
      camSnapped = true
    } else {
      _focus.lerp(_target, 1 - Math.exp(-(dt || 0.016) * 6))
    }
    camera.position.copy(_focus).add(CAM_OFF)
    camera.lookAt(_focus)
    sun.position.copy(_focus).add(SUN_OFF)
    sun.target.position.copy(_focus).add(SUN_TGT)
  }

  function resetVisuals() {
    for (const [, e] of store) disposeEntry(e)
    store.clear()
    chicken.scale.set(1, 1, 1)
    chicken.rotation.set(0, 0, 0)
    camSnapped = false
    if (hud) hud.lastKey = null
  }

  // ---- 对外 view ----
  const view = {
    renderer,
    /** 每帧渲染（shell 的 canvas.requestAnimationFrame 循环里调用）。nowMs 毫秒时间戳。 */
    render(eng, nowMs) {
      const st = eng.getState()
      const dt = lastMs ? Math.min(Math.max((nowMs - lastMs) / 1000, 0), 0.1) : 0.016
      const phaseChanged = st.phase !== lastPhase
      if (phaseChanged && lastPhase === 'dead') resetVisuals() // reset() → ready：世界重建
      syncWorld(st)
      syncChicken(st, dt, nowMs)
      updateCamera(st, dt, phaseChanged && st.phase === 'ready')
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
    /** 主题钩子：壳层 try/catch 调用；当前拍板视觉为浅色，dark 预留 */
    setThemeMode(mode) {
      // 'light' | 'dark'；dark 暂不实现（拍板稿为浅色视觉），不抛错
      return mode === 'dark' ? 'light' : mode
    },
  }
  return view
}

export default createRenderer
