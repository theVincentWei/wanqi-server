/**
 * Road Hop · 引擎自测（M1，无框架：断言 + console）
 *
 * 运行方式二选一（road-hop-build/ 下）：
 * 1) package.json（type:module）存在后：  node test/engine.test.js
 * 2) package.json 尚未创建时（当前），用 three-bench-build 的 esbuild 打成 CJS 跑：
 *    ../../default-workspace/three-bench-build/node_modules/.bin/esbuild test/engine.test.js
 *      --bundle --platform=node --format=cjs --outfile=/tmp/rh-test.cjs
 *    node /tmp/rh-test.cjs
 *
 * 接口为 lead 拍板版：createEngine({cols}) / tap / swipe / tick(秒) / reset / getState，
 * phase 三态 ready|playing|dead，死亡 600ms 重开锁（引擎只供 deadMs，锁在壳层执行）。
 *
 * 覆盖：起步安全 / ready 三态 / 跳跃补间 / 输入排队 / 横移边界 / 树阻挡 /
 *      车碰撞死亡 / 死亡冻结 / 车回绕 / 计分 / rng 注入可复现 / 乌鸦计时 /
 *      reset 保留 best / getState 纯度 / 异常 dt 防御
 */
import { createEngine, mulberry32 } from '../src/engine.js'
import * as C from '../src/constants.js'

var passed = 0
var failed = 0

function ok(cond, msg) {
  if (cond) {
    passed++
    console.log('  PASS  ' + msg)
  } else {
    failed++
    console.error('  FAIL  ' + msg)
  }
}
function eq(a, b, msg) {
  ok(a === b, msg + '（期望 ' + b + '，实际 ' + a + '）')
}
function approx(a, b, eps, msg) {
  ok(Math.abs(a - b) <= eps, msg + '（期望 ~' + b + '+-' + eps + '，实际 ' + a + '）')
}
function section(name) {
  console.log('')
  console.log('== ' + name + ' ==')
}

// tick(0.121) 秒 > 120ms 补间：一跳落地（引擎内部钳上限 200ms，0.121 < 0.2 不受影响）
var LAND = (C.HOP_DURATION_MS + 1) / 1000

// ---------- 1. 起步安全 + ready 三态 ----------
section('起步 3 行安全 / ready 静止')
{
  var eng = createEngine({ rng: mulberry32(1) })
  var st = eng.getState()
  eq(st.phase, 'ready', '初始 phase=ready')
  eq(st.player.row, 0, '初始行')
  eq(st.player.col, C.SPAWN_COL, '初始列 = 9 列正中')
  var safe = st.rows.filter(function (r) { return r.index < C.SAFE_START_ROWS })
  eq(safe.length, C.SAFE_START_ROWS, '可见窗口含前 3 行')
  ok(safe.every(function (r) { return r.type === 'grass' }), '前 3 行全为草地（无车）')
  eq(st.rows.filter(function (r) { return r.index === 0 })[0].trees.length, 0, '出生行无树')
  ok(
    st.rows
      .filter(function (r) { return r.index >= 1 && r.index < C.SAFE_START_ROWS })
      .every(function (r) { return !r.trees.includes(C.SPAWN_COL) }),
    '起步安全行不挡出生列',
  )
  // ready 态世界静止：车流不走、乌鸦不计时
  eng.tick(1); eng.tick(1); eng.tick(1); eng.tick(1); eng.tick(1) // 共 1s（内部每次钳 200ms）
  var st2 = eng.getState()
  eq(st2.phase, 'ready', 'ready 态 1s 后仍是 ready')
  ok(
    JSON.stringify(st2.rows) === JSON.stringify(st.rows),
    'ready 态车流静止（rows 快照逐字节一致）',
  )
}

// ---------- 2. 首次 tap 开局 ----------
section('首次 tap：ready -> playing 并起跳')
{
  var eng = createEngine({ rng: mulberry32(2) })
  eng.tap()
  var st = eng.getState()
  eq(st.phase, 'playing', 'tap 后 phase=playing')
  ok(st.player.tween && st.player.tween.p === 0, '开局即起跳（tween p=0）')
  eng.tick(LAND)
  st = eng.getState()
  eq(st.player.row, 1, '开局跳落地 row=1')
  eq(st.score, 1, '落地计分 score=1')
}

// ---------- 3. rng 注入可复现 ----------
section('rng 注入可复现')
{
  function seq() {
    var eng = createEngine({ rng: mulberry32(42) })
    eng.tap(); eng.tick(0.06)
    eng.tap(); eng.tick(0.06); eng.tick(0.06)
    eng.swipe(1); eng.tick(0.03); eng.tick(0.09)
    eng.tap(); eng.tick(0.12); eng.tick(0.2)
    eng.reset()
    eng.tap(); eng.tick(0.12)
    return JSON.stringify(eng.getState())
  }
  eq(seq(), seq(), '同种子同操作序列（含 reset）→ 状态逐字节一致')
  var engA = createEngine({ rng: mulberry32(42) })
  var engB = createEngine({ rng: mulberry32(43) })
  ok(
    JSON.stringify(engA.getState()) !== JSON.stringify(engB.getState()),
    '不同种子 → 世界生成不同',
  )
  var engDef = createEngine() // 缺省 Math.random 也能跑
  engDef.tap(); engDef.tick(LAND)
  eq(engDef.getState().score, 1, '缺省 rng 可正常游玩')
  var engSeed = createEngine({ seed: 7 }) // seed 简写
  engSeed.tap(); engSeed.tick(LAND)
  var engSeed2 = createEngine({ seed: 7 })
  engSeed2.tap(); engSeed2.tick(LAND)
  ok(
    JSON.stringify(engSeed.getState()) === JSON.stringify(engSeed2.getState()),
    'seed 选项等价于注入 mulberry32(seed)',
  )
}

// ---------- 4. 跳跃补间（120ms） ----------
section('跳跃补间')
{
  var eng = createEngine({ rng: mulberry32(3) })
  eng.tap()
  var st = eng.getState()
  eq(st.player.tween.p, 0, '起跳即进入补间 p=0')
  eq(st.player.tween.toRow, 1, '补间目标行 +1')
  eq(st.player.row, 0, '落地前逻辑行不变')
  eng.tick(0.06) // 半程
  st = eng.getState()
  approx(st.player.tween.p, 0.5, 1e-9, '60ms 后 p~0.5')
  approx(st.player.z, 0.5, 1e-9, 'z 线性插值到半程')
  approx(st.player.x, 4, 1e-9, '前进跳跃 x 不变')
  eng.tick(0.06)
  st = eng.getState()
  eq(st.player.row, 1, '120ms 后落地 row=1')
  eq(st.player.z, 1, '落地 z 对齐行')
  eq(st.player.tween, null, '补间结束置 null')
  eq(st.score, 1, '落地即计分 score=1')
}

// ---------- 5. 输入排队策略：补间中缓存 1 条 ----------
section('输入排队（补间中缓存 1 条，多余丢弃）')
{
  var eng = createEngine({ rng: mulberry32(4) })
  eng.tap()
  eng.tap() // 补间中 → 入队
  eng.tap() // 队满 → 丢弃
  eng.tick(0.06)
  var st = eng.getState()
  approx(st.player.tween.p, 0.5, 1e-9, '第一跳进行中')
  eng.tick(0.06) // 落地 row1，立刻执行预输入 → 第二跳开始
  st = eng.getState()
  ok(st.player.tween && st.player.tween.toRow === 2, '落地瞬间预输入生效（连跳）')
  eng.tick(0.12)
  st = eng.getState()
  eq(st.player.row, 2, '第二跳落地 row=2')
  eq(st.player.tween, null, '被丢弃的第三跳未执行（无第三次连跳）')
  eq(st.score, 2, 'score=2')
}

// ---------- 6. 横移 + 边界 ----------
section('横移与列边界')
{
  // 找一个 row1 完全无树的种子：开局跳到 row1 后整行可自由横移
  var eng = null
  for (var seed = 1; seed <= 500; seed++) {
    var cand = createEngine({ rng: mulberry32(seed) })
    if (cand.getState().rows.filter(function (r) { return r.index === 1 })[0].trees.length === 0) {
      eng = cand
      break
    }
  }
  ok(eng !== null, '找到 row1 无树种子')
  eng.tap() // 开局跳到 row1（ready 态 swipe 不开局，先 tap）
  eng.tick(LAND)
  var st = eng.getState()
  eq(st.player.row, 1, '开局跳落地 row=1')

  eng.swipe(1)
  st = eng.getState()
  ok(st.player.tween && st.player.tween.toCol === 5, 'swipe(+1) 向右一格')
  eng.tick(LAND)
  st = eng.getState()
  eq(st.player.col, 5, '横移落地 col=5')
  eq(st.score, 1, '横移不计分')

  // 推到右边界 col=8
  for (var i = 0; i < 3; i++) { eng.swipe(1); eng.tick(LAND) }
  st = eng.getState()
  eq(st.player.col, C.GRID_COLS - 1, '到达右边界 col=8')
  eng.swipe(1)
  st = eng.getState()
  eq(st.player.tween, null, '右边界外移被吞（不产生补间）')
  eq(st.player.col, C.GRID_COLS - 1, 'col 仍为 8')
  eng.tick(LAND)

  // 推到左边界 col=0
  for (var j = 0; j < 8; j++) { eng.swipe(-1); eng.tick(LAND) }
  st = eng.getState()
  eq(st.player.col, 0, '到达左边界 col=0')
  eng.swipe(-1)
  st = eng.getState()
  eq(st.player.tween, null, '左边界外移被吞')
  eq(st.player.col, 0, 'col 仍为 0')
}

// ---------- 7. 树阻挡 ----------
section('草地树阻挡前进')
{
  // 找一个 row1 无树、row2 有树的种子：站在 row1 上整行自由横移，再撞 row2 的树
  var eng = null
  var treeCol = -1
  for (var seed = 1; seed <= 500; seed++) {
    var cand = createEngine({ rng: mulberry32(seed) })
    var rs = cand.getState().rows
    var t1 = rs.filter(function (r) { return r.index === 1 })[0].trees
    var t2 = rs.filter(function (r) { return r.index === 2 })[0].trees
    if (t1.length === 0 && t2.length > 0) { eng = cand; treeCol = t2[0]; break }
  }
  ok(eng !== null, '找到 row1 无树且 row2 有树的种子')
  eng.tap() // 开局跳到 row1（col4，row1 无树必成功）
  eng.tick(LAND)
  eq(eng.getState().player.row, 1, '已站上待命行 row1')
  // 沿 row1 横移对齐 row2 的树所在列
  var from = eng.getState().player.col
  var dx = Math.sign(treeCol - from)
  for (var k = 0; k < Math.abs(treeCol - from); k++) { eng.swipe(dx); eng.tick(LAND) }
  eq(eng.getState().player.col, treeCol, '已对齐树列')
  eng.tap() // 目标格是树 → 被吞
  var st = eng.getState()
  eq(st.player.tween, null, '撞树输入被吞：无补间')
  eq(st.player.row, 1, '行未变')
  eng.tick(LAND)
  eq(eng.getState().player.row, 1, 'tick 后仍在原行')
}

// ---------- 8. 车碰撞死亡（含死亡冻结） ----------
section('车碰撞 -> 死亡(car) -> 世界冻结')
{
  // 找窗口内含马路行的种子；关乌鸦隔离变量
  var eng = null
  for (var seed = 1; seed <= 500; seed++) {
    var cand = createEngine({ rng: mulberry32(seed), idleCrowMs: 0 })
    if (cand.getState().rows.some(function (r) { return r.type === 'road' })) { eng = cand; break }
  }
  ok(eng !== null, '找到含马路的种子')
  eng.tap() // 开局
  eng.tick(LAND)

  // 沿草地前进，直到下一行是马路（段生成规则保证马路段首行前必为草地 -> 待命行安全）
  var guard = 0
  var st = eng.getState()
  while (st.rows.filter(function (r) { return r.index === st.player.row + 1 })[0].type !== 'road') {
    eng.tap(); eng.tick(LAND)
    st = eng.getState()
    if (st.phase !== 'playing') throw new Error('前进途中意外死亡')
    if (++guard > 20) throw new Error('前进过深仍未遇马路')
  }
  var roadIdx = st.player.row + 1
  eq(st.rows.filter(function (r) { return r.index === st.player.row })[0].type, 'grass', '待命行是草地（等待安全）')

  // 等某辆车进入 |x - col| <= 0.5：120ms 补间内车最多位移 ~0.54，
  // 落地时 |dx| <= 1.04 < 碰撞阈值 1.1 -> 必死
  var waitGuard = 0
  while (true) {
    st = eng.getState()
    var road = st.rows.filter(function (r) { return r.index === roadIdx })[0]
    var near = road.cars.some(function (c) { return Math.abs(c.x - st.player.col) <= 0.5 })
    if (near) break
    eng.tick(0.016)
    if (++waitGuard > 4000) throw new Error('等车超时')
  }
  eq(st.phase, 'playing', '待命行上未被撞')

  eng.tap()
  for (var i2 = 0; i2 < 20 && st.phase === 'playing'; i2++) { eng.tick(0.016); st = eng.getState() }
  eq(st.phase, 'dead', '冲入车流 -> 死亡')
  eq(st.deathReason, 'car', '死亡原因 = car')

  // 死亡冻结：车不再动、补间定格、tap/swipe 忽略（引擎侧 dead 一律忽略，600ms 锁在壳层）
  var frozenCars = st.rows.filter(function (r) { return r.index === roadIdx })[0].cars.map(function (c) { return c.x })
  var frozenZ = st.player.z
  eng.tick(0.1)
  eng.tap()   // dead 态：即使过了 600ms 引擎也忽略（防壳层漏判尸体起跳）
  eng.swipe(1)
  var st2 = eng.getState()
  eq(st2.phase, 'dead', '死亡后 tick/输入不复活')
  eq(st2.player.z, frozenZ, '补间定格不动')
  ok(
    JSON.stringify(st2.rows.filter(function (r) { return r.index === roadIdx })[0].cars.map(function (c) { return c.x })) ===
      JSON.stringify(frozenCars),
    '死亡后车辆全部静止',
  )
  ok(st2.deadMs >= 100, 'deadMs 在死亡后累计（壳层重开锁依据），实际 ' + st2.deadMs)
}

// ---------- 9. 车出界回绕 ----------
section('车辆环形回绕')
{
  var eng = null
  for (var seed = 1; seed <= 500; seed++) {
    var cand = createEngine({ rng: mulberry32(seed), idleCrowMs: 0 })
    if (cand.getState().rows.some(function (r) { return r.type === 'road' })) { eng = cand; break }
  }
  var st0 = eng.getState()
  var road = st0.rows.filter(function (r) { return r.type === 'road' })[0]
  var count0 = road.cars.length
  ok(count0 >= 1, '马路行有 ' + count0 + ' 辆车')
  for (var i = 0; i < 5; i++) eng.tick(0.2) // 1s > 车流穿过全环所需的最短时间量级
  var road2 = eng.getState().rows.filter(function (r) { return r.index === road.index })[0]
  eq(road2.cars.length, count0, '回绕不增减车辆')
  ok(
    road2.cars.every(function (c) { return c.x >= -C.WRAP_PAD - 1e-6 && c.x <= C.GRID_COLS + C.WRAP_PAD + 1e-6 }),
    '车 x 始终在 [-WRAP_PAD, COLS+WRAP_PAD] 环带内',
  )
}

// ---------- 10. 计分 ----------
section('计分 = 到达的最大行数')
{
  var eng = createEngine({ rng: mulberry32(6) })
  eq(eng.getState().score, 0, '初始 0 分')
  eng.tap(); eng.tick(LAND)
  eng.tap(); eng.tick(LAND)
  eq(eng.getState().score, 2, '前进两格 2 分')
  eng.swipe(1); eng.tick(LAND)
  eq(eng.getState().score, 2, '横移不加分')
}

// ---------- 11. 乌鸦（停滞惩罚，可配置） ----------
section('乌鸦计时（idleCrowMs，毫秒）')
{
  // 注意引擎把单次 tick 钳在 MAX_TICK_MS=200ms，测试用 150ms 步进累计停滞时长
  var eng = createEngine({ rng: mulberry32(7), idleCrowMs: 1000 })
  eng.tap() // 开局（ready 态不计时）
  eng.tick(LAND) // 落地 row1，idle 归零
  for (var i = 0; i < 5; i++) eng.tick(0.15) // 停滞 750ms < 1000ms
  eq(eng.getState().phase, 'playing', '750ms 停滞仍存活')
  eng.tap(); eng.tick(LAND) // 前进落地重置计时（此时若无重置，累计已 871ms 接近爆表）
  for (var j = 0; j < 5; j++) eng.tick(0.15) // 重置后 750ms
  eq(eng.getState().phase, 'playing', '落地重置计时生效（未在 1000ms 爆表）')
  for (var k = 0; k < 3; k++) eng.tick(0.15) // 累计 1200ms > 1000ms
  var st = eng.getState()
  eq(st.phase, 'dead', '停滞超时死亡')
  eq(st.deathReason, 'crow', '死亡原因 = crow')

  var engOff = createEngine({ rng: mulberry32(7), idleCrowMs: 0 })
  engOff.tap()
  for (var m = 0; m < 10; m++) engOff.tick(0.2) // 2s 停滞
  eq(engOff.getState().phase, 'playing', 'idleCrowMs=0 -> 乌鸦关闭')
}

// ---------- 12. reset：死亡重开，best 保留 ----------
section('reset() 死亡重开')
{
  var eng = createEngine({ rng: mulberry32(8) })
  eng.best = 7 // 壳层注入
  eng.tap(); eng.tick(LAND); eng.tick(LAND) // score=1（开局跳 + 一跳）
  eq(eng.score, 1, '重开前 score=1')
  eng.reset()
  var st = eng.getState()
  eq(st.phase, 'ready', 'reset 后回到 ready')
  eq(st.score, 0, 'score 清零')
  eq(st.deathReason, null, 'deathReason 清空')
  eq(st.deadMs, 0, 'deadMs 清零')
  eq(st.best, 7, 'best 保留（壳层注入值不被动）')
  eq(st.player.row, 0, '玩家回出生行')
  eq(st.rows.filter(function (r) { return r.index === 0 })[0].trees.length, 0, '新世界出生行无树')
  eng.tap(); eng.tick(LAND)
  eq(eng.score, 1, '重开后可正常开局计分')
}

// ---------- 13. getState 纯度 + 异常 dt ----------
section('getState 纯数据 / 异常 dt 防御')
{
  var eng = createEngine({ rng: mulberry32(9) })
  eng.tap()
  var s1 = eng.getState()
  var s1ref = JSON.stringify(s1)
  s1.player.x = 999
  if (s1.player.tween) s1.player.tween.p = 42
  s1.rows[0].trees.push(-5)
  eq(JSON.stringify(eng.getState()), s1ref, '改动返回值不影响引擎（深拷贝）')

  eng.tick(-0.005) // 负 dt -> 钳 0
  eng.tick(NaN)    // 非法 dt -> 忽略
  eng.tick(1e9)    // 巨 dt -> 钳 MAX_TICK_MS（补间正常完成落地）
  var s2 = eng.getState()
  ok(isFinite(s2.player.x) && isFinite(s2.player.z), '异常 dt 不产生 NaN')
  ok(s2.player.tween === null || s2.player.tween.p <= 1, '巨 dt 被钳制（补间 p 不越界）')
  ok(s2.player.row === 1, '巨 dt 后补间已正常落地 row=1')
}

// ---------- 汇总 ----------
console.log('')
console.log('======== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ========')
if (failed > 0) process.exitCode = 1
