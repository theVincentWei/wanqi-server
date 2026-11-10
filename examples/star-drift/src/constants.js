/**
 * 星际穿行（Star Drift）· 世界常量（全项目唯一数值来源）
 *
 * 单位约定：
 *  - 长度/坐标：world 单位（≈米）；坐标系为船体系：飞船恒在 (0,0)，前方物体 z<0，
 *    随飞行整体向 +z 移动（等效飞船沿 -z 前进，契约口径）
 *  - 速度：world/s
 *  - 时间：引擎对外 tick(dt) 用秒；常量里的时长一律毫秒（引擎内部换算）
 *  - 拖拽：eng.drag(dx) 的 dx 是 css px（壳层从 onTouchMove 原样转发），px→world 映射在引擎内
 *
 * 引擎（engine.js）与渲染层（renderer.js）都从这里 import，禁止在别处散落魔数。
 */

// ---- 玩家/操控 ----
export const HALF_RANGE = 4        // 缺省横向半幅（createEngine({halfRange}) 可覆盖），x 钳制 ±halfRange
export const DRAG_PX_PER_WORLD = 40 // 拖拽灵敏度：40 css px = 1 world 单位（全屏宽 ~390px ≈ 9.75 单位，够横穿 ±4）
export const LERP_RATE = 12        // 横向平滑跟随速率（1/s）：x += (targetX-x) * (1-exp(-rate*dt))
export const SHIP_RADIUS = 0.5     // 飞船碰撞球半径
export const PICKUP_RADIUS = 0.8   // 晶体拾取：与晶体中心距离 < 0.8 即收集

// ---- 速度/密度爬坡 ----
export const SPEED_MIN = 18          // 起始飞行速度 world/s
export const SPEED_MAX = 42          // 远期飞行速度 world/s
export const SPEED_RAMP_DISTANCE = 3000 // 速度爬坡里程（米）：dist 0→该值 线性 MIN→MAX
export const DENSITY_MIN_PER_UNIT = 0.10 // 小行星面密度下限（个/世界单位 z 向）
export const DENSITY_MAX_PER_UNIT = 0.40 // 上限
export const DENSITY_RAMP_DISTANCE = 2600 // 密度爬坡里程（按小行星"抵达飞船时"的里程计）

// ---- 世界生成（z 波段） ----
export const BAND_LENGTH = 20       // 每个生成波段的 z 向长度
export const SAFE_START_DIST = 30   // 起步净空：首个波段前缘距飞船，开局前方 30 单位内无障碍
export const SPAWN_AHEAD = 140      // 内容生成覆盖到前方多远（船体系 -z）
export const DESPAWN_BEHIND = 14    // 物体越过飞船该距离后回收
export const CORRIDOR_RADIUS = 1.2  // 每 z 截面保证的可通过通道半宽（船 r0.5 富余 ~0.7）
export const CORRIDOR_MAX_SHIFT = 2.2  // 相邻波段通道中心最大横移（走折线，斜率 ≤0.11/unit）

// ---- 小行星（3~4 种半径/转速模型复用） ----
// r 碰撞半径；spin 自转角速度 rad/s（引擎再加随机方向）；w 抽取权重
export const ASTEROID_KINDS = [
  { r: 0.7, spin: 0.9,  w: 0.4 },
  { r: 1.1, spin: 0.7,  w: 0.3 },
  { r: 1.6, spin: 0.5,  w: 0.2 },
  { r: 2.1, spin: 0.35, w: 0.1 },
]

// ---- 能量晶体 ----
export const CRYSTAL_CHANCE = 0.65    // 每波段出晶体的概率（通道中心附近穿插，奖励走安全线）
export const CRYSTAL_X_JITTER = 0.6   // 晶体相对通道中心的横向抖动
export const SCORE_PER_CRYSTAL = 50   // 每颗晶体加分

// ---- 引擎行为 ----
export const DEAD_LOCK_MS = 600  // 死亡 600ms 重开锁（壳层执行；引擎提供 deadMs/deadLockMs 供判断）
export const MAX_TICK_S = 0.2    // 单次 tick 的 dt 上限（秒，防后台恢复巨 dt 瞬移/漏检）
