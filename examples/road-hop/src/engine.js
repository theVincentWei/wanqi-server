/**
 * Road Hop · 纯逻辑引擎（M1）
 *
 * 零依赖：不 import three / wx / DOM；随机数经构造参数注入（rng / seed），可完全复现。
 * 数据流向：shell（wx 接线）→ 引擎收 tick(dt)（秒）与输入事件 → 渲染层读 getState() 纯数据绘制。
 * 引擎不持有任何渲染对象，也不调用渲染层。
 *
 * 对外接口（v1 契约，lead 拍板）：
 *   const eng = createEngine({ cols: 9, rng?, seed?, idleCrowMs?, deadLockMs? })
 *   eng.phase    'ready' | 'playing' | 'dead'（getter）
 *   eng.score    已到达的最大行数（getter）
 *   eng.best     由壳层注入/持久化（普通可写属性，引擎只读不写）
 *   eng.deathReason / eng.deadMs（getter，死亡原因 / 死亡后经过的毫秒）
 *   eng.tap()           点按：ready → 开局+跳一格；playing → 前进一格
 *   eng.swipe(dir)      横移一格：dir=-1 左（列-1）/ +1 右（列+1）
 *   eng.tick(dt)        推进 dt 秒（车流 / 补间 / AABB 碰撞 / 乌鸦超时 / 死亡计时）
 *   eng.reset()         死亡重开：干净重建世界与玩家，score/计时清零，best 保留
 *   eng.getState()      纯数据快照（渲染层照此绘制）
 *
 * 坐标约定：世界坐标以 tile 为单位，x = 列（0..cols-1），z = 行（0 起，前进方向递增）。
 * 渲染层自行做相机居中/翻转，引擎只给逻辑坐标。
 *
 * 设计决定（供 review）：
 * 1. 输入排队策略：补间进行中收到的新输入缓存 1 条（先到先得），落地瞬间立即执行；
 *    缓存已满时新输入直接丢弃。理由：120ms 补间下连按节奏约 8Hz，缓存 1 条手感最接近
 *    Crossy Road 的"预输入下一跳"，又不会积压导致松手后角色自己连跳好几格。
 * 2. 被挡输入（树/边界）就地吞掉：不入队、不报错、不开始补间，状态不变。
 * 3. 三态机：ready=开局待命（世界静止、车流不走、乌鸦不计时），首次 tap 进 playing 并立即
 *    起跳；dead=世界冻结，输入一律忽略（600ms 重开锁是壳层 UX 规则，引擎用 deadMs 供其判断；
 *    即使壳层漏判，dead 态 tap 也不会让尸体起跳）。
 * 4. 死亡即冻结：dead 后 tick 只累计 deadMs，车辆/补间停摆；死亡表现由渲染层播。
 * 5. 计分在"落地"时刻结算（而非起跳），score = 已到达的最大行号；reset() 不动 best。
 * 6. 车辆全场推进（不止可见窗口），玩家抵达远处行时车流相位连续自然；行数在百级、
 *    每行车 ≤4，开销可忽略。
 * 7. 乌鸦（停滞惩罚）：默认开（CROW_IDLE_MS），"前进落地"才重置计时（原地横移不算前进）；
 *    可用 createEngine({ idleCrowMs: 0 }) 关闭。
 */

import {
  GRID_COLS, SPAWN_ROW, SAFE_START_ROWS,
  HOP_DURATION_MS,
  PLAYER_HALF,
  CAR_HALF_LENGTH, CAR_HALF_WIDTH,
  CAR_SPEED_MIN, CAR_SPEED_MAX, DIFFICULTY_RAMP_ROWS, WRAP_PAD,
  CAR_SPACING_START, CAR_SPACING_END, CAR_SPACING_JITTER, CAR_SPACING_MIN, CAR_SPACING_MAX,
  TYPE_WEIGHTS, GRASS_RUN_MAX, ROAD_RUN_MAX,
  TREE_DENSITY, TREE_DENSITY_SAFE, TREE_MAX_PER_ROW,
  VIEW_ROWS_AHEAD, VIEW_ROWS_BEHIND, MAX_TICK_MS, CROW_IDLE_MS, DEAD_RESTART_LOCK_MS,
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

const mod = (a, n) => ((a % n) + n) % n
const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)

/**
 * 创建一局游戏。
 * @param {{ cols?: number, rng?: () => number, seed?: number, idleCrowMs?: number, deadLockMs?: number }} [opts]
 *   cols：列数（缺省 9）；rng：随机函数（优先级最高）；seed：rng 缺省时的种子；两者都不给用 Math.random
 *   idleCrowMs：停滞致死毫秒（0=关闭乌鸦，缺省 CROW_IDLE_MS）
 *   deadLockMs：死亡重开锁毫秒（引擎只照此对外承诺 deadMs 语义，锁的执行在壳层，缺省 600）
 */
export function createEngine(opts = {}) {
  const cols = opts.cols != null ? opts.cols : GRID_COLS
  if (!Number.isInteger(cols) || cols < 3) throw new TypeError('cols must be an integer >= 3')
  const rng = typeof opts.rng === 'function'
    ? opts.rng
    : (opts.seed != null ? mulberry32(opts.seed) : Math.random)
  const idleCrowMs = opts.idleCrowMs == null ? CROW_IDLE_MS : opts.idleCrowMs
  const deadLockMs = opts.deadLockMs == null ? DEAD_RESTART_LOCK_MS : opts.deadLockMs

  const spawnCol = Math.floor(cols / 2)
  const loopLen = cols + WRAP_PAD * 2 // 车道环形总长

  // ---- 世界生成（懒生成：按需把行补到需要的行号） ----
  const rows = []
  const gen = { nextIndex: 0, runType: 'grass', runLeft: SAFE_START_ROWS }

  // 下一"段"的类型：马路段后必接草地；草地段后按权重掷骰
  function pickRunType() {
    if (gen.runType === 'road') return 'grass'
    return rng() < TYPE_WEIGHTS.road ? 'road' : 'grass'
  }

  // 难度进度：行号 SAFE_START_ROWS → +DIFFICULTY_RAMP_ROWS 线性 0→1
  const difficultyT = (index) =>
    clamp01((index - SAFE_START_ROWS) / DIFFICULTY_RAMP_ROWS)

  function makeRow(index) {
    if (gen.runLeft <= 0) {
      gen.runType = pickRunType()
      gen.runLeft = gen.runType === 'road'
        ? 1 + Math.floor(rng() * ROAD_RUN_MAX)
        : 1 + Math.floor(rng() * GRASS_RUN_MAX)
    }
    gen.runLeft--

    const safe = index < SAFE_START_ROWS // 起步 3 行强制草地
    const type = safe ? 'grass' : gen.runType

    if (type === 'grass') {
      if (index === SPAWN_ROW) return { index, type, trees: [] } // 出生行完全无树
      const density = safe ? TREE_DENSITY_SAFE : TREE_DENSITY
      const trees = []
      for (let c = 0; c < cols && trees.length < TREE_MAX_PER_ROW; c++) {
        if (safe && c === spawnCol) continue // 起步行不挡出生列
        if (rng() < density) trees.push(c)
      }
      return { index, type, trees }
    }

    // 马路行：双向（每行随机定一个方向）、单车道一速、车在环形车道上匀距回绕
    const t = difficultyT(index)
    const speed = lerp(CAR_SPEED_MIN, CAR_SPEED_MAX, t * (0.7 + 0.3 * rng()))
    let spacing = lerp(CAR_SPACING_START, CAR_SPACING_END, t) + rng() * CAR_SPACING_JITTER
    spacing = Math.min(CAR_SPACING_MAX, Math.max(CAR_SPACING_MIN, spacing))
    const count = Math.max(1, Math.floor(loopLen / spacing))
    const phase = rng() * loopLen
    const dir = rng() < 0.5 ? -1 : 1
    const cars = []
    for (let i = 0; i < count; i++) {
      cars.push({ s: mod(phase + (i * loopLen) / count, loopLen) }) // s: 环上弧长位置
    }
    return { index, type: 'road', dir, speed, cars }
  }

  function ensureRows(upto) {
    while (gen.nextIndex <= upto) rows.push(makeRow(gen.nextIndex++))
  }

  // ---- 玩家与局内状态 ----
  const player = { row: SPAWN_ROW, col: spawnCol, x: spawnCol, z: SPAWN_ROW, tween: null }
  let phase = 'ready'    // 'ready' | 'playing' | 'dead'
  let score = SPAWN_ROW
  let deathReason = null // 'car' | 'crow' | null
  let deadMs = 0         // 死亡后累计毫秒（壳层 600ms 重开锁的判断依据）
  let queued = null      // 预输入缓存（≤1 条，见文件头设计决定 1）
  let idleMs = 0         // 乌鸦计时：只在"前进落地"时清零

  function resetWorld() {
    rows.length = 0
    gen.nextIndex = 0
    gen.runType = 'grass'
    gen.runLeft = SAFE_START_ROWS
    player.row = SPAWN_ROW
    player.col = spawnCol
    player.x = spawnCol
    player.z = SPAWN_ROW
    player.tween = null
  }

  const cellBlocked = (row, col) => {
    if (row < 0 || col < 0 || col >= cols) return true
    ensureRows(row)
    const r = rows[row]
    return r.type === 'grass' && r.trees.includes(col)
  }

  // 开始一次跳跃补间；目标格被挡则返回 false（输入就地吞掉）
  function startTween(dCol, dRow) {
    const toRow = player.row + dRow
    const toCol = player.col + dCol
    if (cellBlocked(toRow, toCol)) return false
    ensureRows(toRow + VIEW_ROWS_AHEAD)
    player.tween = { fromRow: player.row, fromCol: player.col, toRow, toCol, p: 0 }
    return true
  }

  // 输入统一入口：只在 playing 生效；补间中缓存 1 条；空闲则立刻尝试（被挡就吞掉）
  function submit(dCol, dRow) {
    if (phase !== 'playing') return
    if (player.tween) {
      if (!queued) queued = { dCol, dRow }
      return
    }
    startTween(dCol, dRow)
  }

  function land() {
    const tw = player.tween
    player.row = tw.toRow
    player.col = tw.toCol
    player.x = tw.toCol
    player.z = tw.toRow
    player.tween = null
    if (player.row > score) {
      score = player.row // 计分 = 到达的最大行数
      idleMs = 0        // 只有前进落地才重置乌鸦计时
    }
    // 落地瞬间执行预输入（补间剩余时间丢弃——120ms 粒度对手感无感知影响）
    if (queued) {
      const q = queued
      queued = null
      startTween(q.dCol, q.dRow)
    }
  }

  function die(reason) {
    phase = 'dead'
    deathReason = reason
    deadMs = 0
    queued = null
    // 补间与车辆全部冻结（tick 里 dead 分支短路），死亡表现由渲染层播
  }

  // ---- 对外方法 ----

  /** 推进一帧。dt 单位秒（shell 从 rAF 时间戳差值换算）；引擎内部钳到 [0, MAX_TICK_MS] 毫秒。 */
  function tick(dt) {
    if (!isFinite(dt)) return
    const ms = Math.min(Math.max(dt * 1000, 0), MAX_TICK_MS)
    if (phase === 'dead') {
      deadMs += ms // 世界冻结，只走死亡计时（壳层 600ms 锁）
      return
    }
    if (phase !== 'playing') return // ready：世界静止（车流不走、乌鸦不计时）

    // 1) 跳跃补间（x/z 线性插值；跳跃弧高是纯视觉，渲染层用 tween.p 自行计算）
    if (player.tween) {
      const tw = player.tween
      tw.p += ms / HOP_DURATION_MS
      if (tw.p >= 1) {
        land()
      } else {
        player.x = lerp(tw.fromCol, tw.toCol, tw.p)
        player.z = lerp(tw.fromRow, tw.toRow, tw.p)
      }
    }

    // 2) 车辆推进：全场推进保持相位连续；出界在环形车道上回绕
    const dtS = ms / 1000
    for (const r of rows) {
      if (r.type !== 'road') continue
      for (const c of r.cars) c.s = mod(c.s + r.dir * r.speed * dtS, loopLen)
    }

    // 3) 碰撞：AABB 玩家(0.6×0.6, 半 0.3) vs 车(1.6×0.9, 半 0.8/0.45)
    //    补间中玩家用插值坐标（可被"迎面车"撞死在半空）
    const px = player.x
    const pz = player.z
    const zReach = CAR_HALF_WIDTH + PLAYER_HALF // 0.75
    const xReach = CAR_HALF_LENGTH + PLAYER_HALF // 1.1
    const r0 = Math.max(0, Math.floor(pz - 1))
    const r1 = Math.floor(pz + 1)
    for (let ri = r0; ri <= r1 && phase === 'playing'; ri++) {
      const r = rows[ri]
      if (!r || r.type !== 'road') continue
      if (Math.abs(pz - ri) >= zReach) continue
      for (const c of r.cars) {
        if (Math.abs(px - (c.s - WRAP_PAD)) < xReach) {
          die('car')
          break
        }
      }
    }

    // 4) 乌鸦：停滞太久带走（默认开；idleCrowMs=0 关闭）
    if (phase === 'playing' && idleCrowMs > 0) {
      idleMs += ms
      if (idleMs >= idleCrowMs) die('crow')
    }
  }

  /** 点按：ready → 开局并跳一格；playing → 前跳一格；dead → 忽略（重开由壳层调 reset()） */
  function tap() {
    if (phase === 'ready') {
      phase = 'playing'
      idleMs = 0
      startTween(0, 1) // 出生列起步行无树，必成功
      return
    }
    submit(0, 1)
  }

  /** 横移一格：dir=-1 左（列-1）、+1 右（列+1）；补间中按排队策略缓存；非 playing 忽略 */
  function swipe(dir) {
    if (dir > 0) submit(1, 0)
    else if (dir < 0) submit(-1, 0)
  }

  /** 死亡重开：干净重建世界与玩家；score/计时清零；best 保留（壳层持久化，引擎只读） */
  function reset() {
    resetWorld()
    phase = 'ready'
    score = SPAWN_ROW
    deathReason = null
    deadMs = 0
    queued = null
    idleMs = 0
  }

  /**
   * 纯数据快照（渲染层照此绘制；返回值与引擎内部无共享引用，随便改不影响引擎）：
   * {
   *   phase: 'ready' | 'playing' | 'dead',
   *   score: number,                  // 到达的最大行号
   *   deathReason: null | 'car' | 'crow',
   *   deadMs: number,                 // 死亡后经过毫秒（壳层 600ms 重开锁）
   *   best: number,                   // 透传 eng.best（壳层注入），方便渲染层一次拿全
   *   player: {
   *     row, col,                     // 逻辑格（补间目标格）
   *     x, z,                         // 连续世界坐标（补间中为插值值），tile 单位
   *     tween: null | { fromRow, fromCol, toRow, toCol, p }, // p∈[0,1]，弧高由渲染层用 p 算
   *   },
   *   rows: [                         // 可见窗口 [view.from, view.to]，行号连续
   *     { index, type: 'grass', trees: number[] },
   *     { index, type: 'road',  dir: -1|1, speed, cars: [{ x }] }, // x 为车中心列坐标（可超出 0..cols-1）
   *   ],
   *   view: { from, to },
   * }
   */
  function getState() {
    const center = Math.round(player.z)
    const from = Math.max(0, center - VIEW_ROWS_BEHIND)
    const to = center + VIEW_ROWS_AHEAD
    ensureRows(to)
    const outRows = []
    for (let i = from; i <= to; i++) {
      const r = rows[i]
      if (r.type === 'grass') {
        outRows.push({ index: r.index, type: r.type, trees: r.trees.slice() })
      } else {
        outRows.push({
          index: r.index, type: r.type, dir: r.dir, speed: r.speed,
          cars: r.cars.map((c) => ({ x: c.s - WRAP_PAD })),
        })
      }
    }
    return {
      phase,
      score,
      deathReason,
      deadMs,
      best: eng.best,
      player: {
        row: player.row,
        col: player.col,
        x: player.x,
        z: player.z,
        tween: player.tween
          ? {
              fromRow: player.tween.fromRow, fromCol: player.tween.fromCol,
              toRow: player.tween.toRow, toCol: player.tween.toCol, p: player.tween.p,
            }
          : null,
      },
      rows: outRows,
      view: { from, to },
    }
  }

  const eng = {
    best: 0, // 壳层注入/持久化（引擎只读不写；getState 会透传）
    tap, swipe, tick, reset, getState,
  }
  Object.defineProperties(eng, {
    phase: { get: () => phase, enumerable: true },
    score: { get: () => score, enumerable: true },
    deathReason: { get: () => deathReason, enumerable: true },
    deadMs: { get: () => deadMs, enumerable: true },
    deadLockMs: { get: () => deadLockMs, enumerable: true },
  })
  return eng
}
