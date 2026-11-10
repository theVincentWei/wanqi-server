/**
 * Road Hop · 世界常量（全项目唯一数值来源）
 *
 * 单位约定：
 *  - 长度/坐标：tile 单位（1 tile = 1 世界单位）；引擎坐标 x=列、z=行（见 engine.js）
 *  - 速度：tile/秒
 *  - 时间：引擎对外 tick(dt) 用秒；常量里的时长一律毫秒（引擎内部换算）
 *
 * 引擎（engine.js）与渲染层（renderer.js）都从这里 import，禁止在别处散落魔数。
 */

// ---- 网格 ----
export const TILE_SIZE = 1        // 1 格 = 1 世界单位
export const GRID_COLS = 9        // 缺省列数（竖屏正交相机可见 ~9-10 列）；引擎按 createEngine({cols}) 推导
export const SPAWN_COL = 4        // 缺省出生列（cols=9 的正中，0 基）；引擎按 cols 推导
export const SPAWN_ROW = 0        // 出生行（行号随玩家前进方向递增）
export const SAFE_START_ROWS = 3  // 起步保障：前 3 行（0..2）必为草地且无车；row0 完全无树，row1/2 不挡出生列

// ---- 玩家 ----
export const HOP_DURATION_MS = 120 // 一次跳跃（前进/横移共用）的补间时长
export const HOP_ARC_HEIGHT = 0.5  // 跳跃弧线峰值（渲染层用 sin(π·p) 乘它做视觉抬升；纯显示，不参与碰撞）
export const PLAYER_SIZE = 0.6     // 玩家 AABB 边长（中心对齐格心）
export const PLAYER_HALF = PLAYER_SIZE / 2

// ---- 车辆 ----
export const CAR_LENGTH = 1.6      // 车长（行进方向，x 轴）
export const CAR_WIDTH = 0.9       // 车宽（垂直行进方向，z 轴）
export const CAR_HALF_LENGTH = CAR_LENGTH / 2
export const CAR_HALF_WIDTH = CAR_WIDTH / 2

export const CAR_SPEED_MIN = 2.0     // 车速下限（开局附近）tile/s
export const CAR_SPEED_MAX = 4.5     // 车速上限（远期）tile/s
export const DIFFICULTY_RAMP_ROWS = 40 // 难度爬坡：行号 0→该值，速度/车距线性从易到难
export const WRAP_PAD = 2            // 车道两侧回绕余量：车驶出 [-PAD, COLS+PAD) 即从另一侧进入
export const LOOP_LEN = GRID_COLS + WRAP_PAD * 2 // 缺省车道环形总长（tile，cols=9 时）；引擎按 cols 推导

// 同车道相邻车的环形中心间距（tile）：起步宽、随行号收紧，保证可穿行
export const CAR_SPACING_START = 5.5   // 开局平均间距
export const CAR_SPACING_END = 3.8     // 远期平均间距
export const CAR_SPACING_JITTER = 1.2  // 在均值上叠加 [0, jitter) 随机量
export const CAR_SPACING_MIN = 3.2     // 间距下限 → 车与车间隙 ≥ 1.6 tile，玩家必可穿过
export const CAR_SPACING_MAX = 7.0     // 间距上限

// ---- 行类型（草地=安全可随机树 / 马路=车辆双向） ----
// 草地段结束后按下权重选下一段类型；马路段结束后必接草地（强制休息带）
export const TYPE_WEIGHTS = { grass: 0.45, road: 0.55 }
export const GRASS_RUN_MAX = 2        // 连续草地段长度：1..2 行
export const ROAD_RUN_MAX = 3         // 连续马路段长度：1..3 行
export const TREE_DENSITY = 0.18      // 普通草地每格成树概率
export const TREE_DENSITY_SAFE = 0.08 // 起步安全行（row1/2）树密度减半再减
export const TREE_MAX_PER_ROW = 4     // 每行最多树数（9 列 → 至少 5 格可通行）

// ---- 视口 / 引擎行为 ----
export const VIEW_ROWS_AHEAD = 18   // getState 可见窗口：玩家前方行数（定稿相机偏移 (2.2,13,7.6)、正交半高 10.82、
export const VIEW_ROWS_BEHIND = 10  // 行投影高 0.82 world/行 → 玩家上方可见 ~17.7 行、下方 ~8.7 行，按此给足避免露底）
export const MAX_TICK_MS = 200      // 单次 tick 的 dt 上限（防后台恢复巨 dt 导致车辆瞬移/碰撞漏检）
export const CROW_IDLE_MS = 15000   // 停滞该时长 → 乌鸦带走（死亡 reason 'crow'，契约 MVP 行为）；0 = 关闭
export const DEAD_RESTART_LOCK_MS = 600 // 死亡后 600ms 内点按忽略；之后由壳层调 eng.reset() 重开（引擎侧 dead 态一律忽略输入，deadMs 供壳层判锁）
