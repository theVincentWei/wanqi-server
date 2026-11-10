/**
 * 星际穿行（Star Drift）· 纯逻辑引擎（M1）
 *
 * 零依赖：不 import three / wx / DOM；随机数经构造参数注入（rng / seed），可完全复现。
 * 数据流向：shell（wx 接线）→ 引擎收 tick(dt 秒) 与 tap()/drag(dx css px) → 渲染层读 getState() 纯数据绘制。
 * 引擎不持有任何渲染对象，也不调用渲染层。
 *
 * 坐标系（船体系，渲染层相机锚定飞船即可）：
 *   飞船恒在 (x, 0)，z 恒为 0；契约口径"飞船沿 -z 前进"体现为：前方物体 z<0，全部世界物体
 *   每帧向 +z 移动 speed*dt（等效前进）。物体 z 越过 DESPAWN_BEHIND 回收，前方按 z 波段补给，
 *   覆盖恒到 -SPAWN_AHEAD。y 轴不参与逻辑（碰撞在 xz 平面；渲染层若做视觉 y 抖动须保持碰撞球不穿帮）。
 *
 * 对外接口（v1 契约，lead 拍板）：
 *   const eng = createEngine({ halfRange?, rng?, seed?, startDistance?, deadLockMs? })
 *   eng.phase    'ready' | 'playing' | 'dead'（getter）
 *   eng.score    距离(米，取整) + 晶体×50（getter）
 *   eng.best     壳层注入/持久化（普通可写属性，引擎只读不写；getState 透传）
 *   eng.deathReason / eng.deadMs / eng.deadLockMs（getter）
 *   eng.drag(dx) 拖拽增量，dx 单位 css px（壳层 onTouchMove 逐事件原样转发）；
 *                引擎内做 px→world（DRAG_PX_PER_WORLD）并累加到 targetX，钳 ±halfRange
 *   eng.tap()    ready→开局；playing 中无操作（本作无跳跃/冲刺，预留避免误触副作用；dead 忽略）
 *   eng.tick(dt) 推进 dt 秒（速度爬坡 / 横向 lerp / 世界滚动 / 波段生成回收 / 碰撞 / 拾取）
 *   eng.reset()  死亡重开：干净重建世界，score/计时尚清零，best 保留
 *   eng.getState() 纯数据快照（渲染层照此绘制）
 *
 * 设计决定（供 review）：
 * 1. 拖拽模型：drag 只动"目标位 targetX"，实际 x 用帧率无关的指数平滑
 *    （x += (targetX-x)*(1-exp(-LERP_RATE*dt))）跟随——手感有惯性又不漂。px→world 映射
 *    固定 DRAG_PX_PER_WORLD=40（全屏宽 ≈9.75 单位 > 2×halfRange，够一次拖穿全场）；
 *    壳层不做缩放，起止位移 ≤12px 判点按（tap）否则按拖拽是壳层策略，引擎两侧都兼容。
 * 2. 通道保证：走廊是跨波段连续折线（每波段边界一个控制点，横移 ≤CORRIDOR_MAX_SHIFT，
 *    斜率 ≤0.11/unit）。小行星候选位若落入"走廊中心(按 z 插值) ± (CORRIDOR_RADIUS+r)"内
 *    则重采样/丢弃——任意 z 截面沿走廊都存在 ≥r+0.96 的横向净空（> 船 r0.5）。
 *    晶体放在走廊中心附近（抖动 ±0.6），奖励走安全线。
 * 3. 三态机：ready=标题画面（世界已生成但静止），tap 开局；playing 正常；dead 世界冻结
 *    （tick 只累计 deadMs），输入全忽略——600ms 重开锁在壳层执行，引擎供 deadMs/deadLockMs。
 * 4. 计分实时结算：score = floor(dist) + crystals*50，随 tick 变化（不是死亡才结算）；
 *    撞小行星立即死亡 deathReason='asteroid'（MVP 无护盾）。
 * 5. 死亡重演：reset() 用同一 rng 流继续生成（连续对局不重样）；要固定局面用 seed。
 */

import {
  HALF_RANGE, DRAG_PX_PER_WORLD, LERP_RATE, SHIP_RADIUS, PICKUP_RADIUS,
  SPEED_MIN, SPEED_MAX, SPEED_RAMP_DISTANCE,
  DENSITY_MIN_PER_UNIT, DENSITY_MAX_PER_UNIT, DENSITY_RAMP_DISTANCE,
  BAND_LENGTH, SAFE_START_DIST, SPAWN_AHEAD, DESPAWN_BEHIND,
  CORRIDOR_RADIUS, CORRIDOR_MAX_SHIFT,
  ASTEROID_KINDS,
  CRYSTAL_CHANCE, CRYSTAL_X_JITTER, SCORE_PER_CRYSTAL,
  DEAD_LOCK_MS, MAX_TICK_S,
} from './constants.js'

/** 可复现随机源（无依赖实现，种子 → [0,1)），壳层可选：createEngine({ seed: n }) */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * 创建一局游戏。
 * @param {{ halfRange?: number, rng?: () => number, seed?: number, startDistance?: number, deadLockMs?: number }} [opts]
 *   halfRange：横向半幅（缺省 4，x 钳 ±halfRange）；rng 优先级最高；seed：rng 缺省时的种子；
 *   startDistance：起始里程热启动（缺省 0；速度/密度爬坡直接从该里程起步，调试与"续跑"复用）；
 *   deadLockMs：死亡重开锁毫秒（缺省 600，锁的执行在壳层）；其余未知字段一律忽略（shell 可透传整个参数对象）
 */
export function createEngine(opts = {}) {
  const halfRange = opts.halfRange != null ? opts.halfRange : HALF_RANGE
  if (!isFinite(halfRange) || halfRange < 1) throw new TypeError('halfRange must be a number >= 1')
  const startDistance = opts.startDistance != null ? Math.max(0, opts.startDistance) : 0
  if (!isFinite(startDistance)) throw new TypeError('startDistance must be a finite number')
  const rng = typeof opts.rng === 'function'
    ? opts.rng
    : (opts.seed != null ? mulberry32(opts.seed) : Math.random)
  const deadLockMs = opts.deadLockMs == null ? DEAD_LOCK_MS : opts.deadLockMs

  const corridorXLimit = halfRange - 0.5 // 通道中心范围（留 0.5 余量，保证通道不出 ±halfRange）
  const spawnXRange = halfRange + 0.5    // 小行星中心横向范围（可略压边界）

  // ---- 局内状态 ----
  let phase = 'ready'
  let dist = startDistance // 飞行里程（米；热启动起点）
  let crystalsRun = 0   // 本局晶体数
  let score = 0
  let deathReason = null // 'asteroid' | null
  let deadMs = 0
  let targetX = 0
  let x = 0
  let speed = lerp(SPEED_MIN, SPEED_MAX, clamp01(dist / SPEED_RAMP_DISTANCE))
  const asteroids = []  // {x, z, r, spin} z<0 在前方
  const crystals = []   // {x, z}
  let genFrontZ = -SAFE_START_DIST          // 已生成内容的最远前缘（最负 z）
  const corridorNodes = [{ z: -SAFE_START_DIST, x: 0 }] // 走廊控制点，z 降序

  // 走廊中心按 z 线性插值（跨波段连续折线）
  function corridorXAt(z) {
    const ns = corridorNodes
    for (let i = 0; i < ns.length - 1; i++) {
      const a = ns[i]
      const b = ns[i + 1]
      if (z <= a.z && z >= b.z) return lerp(a.x, b.x, (a.z - z) / (a.z - b.z))
    }
    return ns[ns.length - 1].x
  }

  function pickKind() {
    let roll = rng() * ASTEROID_KINDS.reduce((s, k) => s + k.w, 0)
    for (const k of ASTEROID_KINDS) {
      roll -= k.w
      if (roll < 0) return k
    }
    return ASTEROID_KINDS[0]
  }

  /** 在 [genFrontZ-BAND_LENGTH, genFrontZ] 生成一个波段（含通道保证 + 穿插晶体） */
  function makeBand() {
    const nearZ = genFrontZ
    const farZ = nearZ - BAND_LENGTH
    const prevX = corridorXAt(nearZ)
    const nextX = clamp(
      prevX + (rng() * 2 - 1) * CORRIDOR_MAX_SHIFT,
      -corridorXLimit, corridorXLimit,
    )
    corridorNodes.push({ z: farZ, x: nextX })

    // 密度按"该波段抵达飞船时"的里程爬坡
    const encounterDist = dist + (nearZ - farZ) / 2
    const density = lerp(
      DENSITY_MIN_PER_UNIT, DENSITY_MAX_PER_UNIT,
      clamp01(encounterDist / DENSITY_RAMP_DISTANCE),
    )
    const count = Math.max(1, Math.round(BAND_LENGTH * density * (0.8 + 0.4 * rng())))
    let placed = 0
    for (let i = 0; i < count * 6 && placed < count; i++) {
      const kind = pickKind()
      const az = lerp(farZ, nearZ, rng())
      const ax = lerp(-spawnXRange, spawnXRange, rng())
      // 通道保证：相对走廊中心(插值)留出 CORRIDOR_RADIUS + r 的横向净空
      if (Math.abs(ax - corridorXAt(az)) < CORRIDOR_RADIUS + kind.r) continue
      asteroids.push({ x: ax, z: az, r: kind.r, spin: kind.spin * (rng() < 0.5 ? -1 : 1) })
      placed++
    }

    // 晶体穿插：走廊中心附近，且不埋进小行星
    if (rng() < CRYSTAL_CHANCE) {
      for (let tries = 0; tries < 6; tries++) {
        const cz = lerp(farZ, nearZ, rng())
        const cx = corridorXAt(cz) + (rng() * 2 - 1) * CRYSTAL_X_JITTER
        let clear = true
        for (const a of asteroids) {
          if (a.z < farZ || a.z > nearZ) continue
          const dx = a.x - cx
          const dz = a.z - cz
          if (dx * dx + dz * dz < (a.r + 0.6) * (a.r + 0.6)) { clear = false; break }
        }
        if (clear) { crystals.push({ x: cx, z: cz }); break }
      }
    }
    genFrontZ = farZ
  }

  function refill() {
    while (genFrontZ > -SPAWN_AHEAD) makeBand()
  }
  refill() // 创建即生成整窗内容（ready 标题画面有星域可画）

  function die(reason) {
    phase = 'dead'
    deathReason = reason
    deadMs = 0
    // 世界冻结（tick 里 dead 分支短路），死亡表现由渲染层播
  }

  // ---- 对外方法 ----

  /** 推进一帧。dt 单位秒（shell 从 rAF 时间戳差值换算）；引擎内部钳到 [0, MAX_TICK_S]。 */
  function tick(dt) {
    if (!isFinite(dt)) return
    const dtS = clamp(dt, 0, MAX_TICK_S)
    if (phase === 'dead') {
      deadMs += dtS * 1000 // 世界冻结，只走死亡计时（壳层 600ms 锁）
      return
    }
    if (phase !== 'playing') return // ready：世界静止

    // 1) 速度随里程爬坡，累计里程
    speed = lerp(SPEED_MIN, SPEED_MAX, clamp01(dist / SPEED_RAMP_DISTANCE))
    dist += speed * dtS

    // 2) 横向平滑跟随（帧率无关指数平滑）
    const k = 1 - Math.exp(-LERP_RATE * dtS)
    x += (targetX - x) * k

    // 3) 世界滚动（船体系：物体向 +z 移动）与波段补给/回收
    const dz = speed * dtS
    for (const a of asteroids) a.z += dz
    for (const c of crystals) c.z += dz
    genFrontZ += dz
    for (const n of corridorNodes) n.z += dz
    for (let i = asteroids.length - 1; i >= 0; i--) {
      if (asteroids[i].z > DESPAWN_BEHIND) asteroids.splice(i, 1)
    }
    for (let i = crystals.length - 1; i >= 0; i--) {
      if (crystals[i].z > DESPAWN_BEHIND) crystals.splice(i, 1)
    }
    // 走廊节点：保留身后一个控制点即可满足存活物体的插值区间
    while (corridorNodes.length > 2 && corridorNodes[1].z > DESPAWN_BEHIND) corridorNodes.shift()
    refill()

    // 4) 碰撞（球近似，xz 平面）：撞小行星 = 死亡
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i]
      const dx = a.x - x
      const dzz = a.z
      const rr = a.r + SHIP_RADIUS
      if (dx * dx + dzz * dzz < rr * rr) { die('asteroid'); break }
    }

    // 5) 晶体拾取（球阈值 PICKUP_RADIUS）
    if (phase === 'playing') {
      for (let i = crystals.length - 1; i >= 0; i--) {
        const c = crystals[i]
        const dx = c.x - x
        const dzz = c.z
        if (dx * dx + dzz * dzz < PICKUP_RADIUS * PICKUP_RADIUS) {
          crystals.splice(i, 1)
          crystalsRun++
        }
      }
    }

    // 6) 计分实时结算：距离(米取整) + 晶体×50
    score = Math.floor(dist) + crystalsRun * SCORE_PER_CRYSTAL
  }

  /**
   * 拖拽增量：dx 单位 css px（壳层 onTouchMove 逐事件原样转发，引擎内 px→world）。
   * 只改目标位 targetX（钳 ±halfRange），实际 x 由 tick 里 lerp 平滑跟随。
   * ready/dead 忽略（壳层死亡期本就不上报，引擎侧双保险）。
   */
  function drag(dx) {
    if (phase !== 'playing' || !isFinite(dx)) return
    targetX = clamp(targetX + dx / DRAG_PX_PER_WORLD, -halfRange, halfRange)
  }

  /** 点按：ready→开局；playing 中无操作（本作无跳跃/冲刺机制，预留位）；dead 忽略 */
  function tap() {
    if (phase === 'ready') {
      phase = 'playing'
      return
    }
    // playing：刻意 no-op，见函数头注释
  }

  /** 死亡重开：干净重建世界与飞船；score/计时尚清零；best 保留（壳层持久化，引擎只读） */
  function reset() {
    asteroids.length = 0
    crystals.length = 0
    corridorNodes.length = 0
    corridorNodes.push({ z: -SAFE_START_DIST, x: 0 })
    genFrontZ = -SAFE_START_DIST
    dist = startDistance
    crystalsRun = 0
    score = 0
    deathReason = null
    deadMs = 0
    targetX = 0
    x = 0
    speed = lerp(SPEED_MIN, SPEED_MAX, clamp01(dist / SPEED_RAMP_DISTANCE))
    phase = 'ready'
    refill()
  }

  /**
   * 纯数据快照（渲染层照此绘制；返回值与引擎内部无共享引用，随便改不影响引擎）：
   * {
   *   phase: 'ready' | 'playing' | 'dead',
   *   score: number,               // floor(dist) + crystals*50
   *   deathReason: null | 'asteroid',
   *   deadMs: number,              // 死亡后经过毫秒（壳层 600ms 重开锁）
   *   deadLockMs: number,          // 重开锁时长（读它，别硬编码）
   *   best: number,                // 透传 eng.best（壳层注入）
   *   player: { x, z, targetX },   // z 恒 0（船体系）；x 实际位，targetX 目标位（渲染层可拿差值做翻滚倾斜）
   *   asteroids: [{ x, z, r, spin }], // spin 为带符号自转角速度 rad/s
   *   crystals:  [{ x, z }],
   *   speed: number,               // 当前飞行速度 world/s
   *   view: { from, to },          // 可见 z 窗口 [from, to] = [-SPAWN_AHEAD, DESPAWN_BEHIND]
   * }
   */
  function getState() {
    return {
      phase,
      score,
      deathReason,
      deadMs,
      deadLockMs,
      best: eng.best,
      player: { x, z: 0, targetX },
      asteroids: asteroids.map((a) => ({ x: a.x, z: a.z, r: a.r, spin: a.spin })),
      crystals: crystals.map((c) => ({ x: c.x, z: c.z })),
      speed,
      view: { from: -SPAWN_AHEAD, to: DESPAWN_BEHIND },
    }
  }

  const eng = {
    best: 0, // 壳层注入/持久化（引擎只读不写；getState 会透传）
    drag, tap, tick, reset, getState,
  }
  Object.defineProperties(eng, {
    phase: { get: () => phase, enumerable: true },
    score: { get: () => score, enumerable: true },
    deathReason: { get: () => deathReason, enumerable: true },
    deadMs: { get: () => deadMs, enumerable: true },
    deadLockMs: { get: () => deadLockMs, enumerable: true },
    halfRange: { get: () => halfRange, enumerable: true },
    distance: { get: () => dist, enumerable: true }, // 里程只读暴露（调试/测试用，渲染层请用 score）
  })
  return eng
}
