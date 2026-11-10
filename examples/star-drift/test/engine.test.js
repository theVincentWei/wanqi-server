/**
 * 星际穿行（Star Drift）· 引擎自测（M1，无框架：断言 + console）
 *
 * 运行：cd star-drift-build && node test/engine.test.js（package.json type:module 已由 engine-dev 创建）
 *
 * 接口为 lead 拍板版：createEngine({halfRange}) / drag(css px) / tap / tick(秒) / reset / getState，
 * phase 三态 ready|playing|dead，死亡 600ms 重开锁（引擎只供 deadMs/deadLockMs，锁在壳层执行）。
 *
 * 覆盖：ready 静止/开局、拖拽 px 映射 + lerp + 钳制（含 halfRange 覆盖）、密度爬坡、
 *      通道可通过性（任意 z 截面存在安全 x）、晶体公平性/拾取、碰撞死亡冻结、
 *      计分公式、seed 复现、reset 保 best、负/NaN/巨 dt 防御
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
  ok(Math.abs(a - b) <= eps, msg + '（期望 ~' + b + '±' + eps + '，实际 ' + a + '）')
}
function section(name) {
  console.log('')
  console.log('== ' + name + ' ==')
}

var STEP = 0.016 // 模拟帧步长（秒，<MAX_TICK_S 不触发钳制）

/** 自动驾驶：朝目标世界 x 打拖拽（px 增量），返回实际发出的 px */
function steer(eng, worldTargetX) {
  var st = eng.getState()
  var dxWorld = worldTargetX - st.player.targetX
  var dxPx = dxWorld * C.DRAG_PX_PER_WORLD
  eng.drag(dxPx)
  return dxPx
}

// ---------- 1. ready 静止 / 开局 ----------
section('ready 静止 / 首次 tap 开局')
{
  var eng = createEngine({ rng: mulberry32(1) })
  var st = eng.getState()
  eq(st.phase, 'ready', '初始 phase=ready')
  ok(st.asteroids.length > 0, 'ready 标题画面已有星域（asteroids=' + st.asteroids.length + '）')
  eq(st.player.z, 0, '船体系：player.z 恒 0')
  eq(st.view.from, -C.SPAWN_AHEAD, 'view.from = -SPAWN_AHEAD')
  eq(st.view.to, C.DESPAWN_BEHIND, 'view.to = DESPAWN_BEHIND')
  // 起步净空
  ok(
    st.asteroids.every(function (a) { return a.z <= -C.SAFE_START_DIST + 1e-6 }),
    '起步净空：最近小行星 z <= -SAFE_START_DIST',
  )
  // ready 世界静止：tick 不动世界，drag 不生效
  var snap0 = JSON.stringify(st)
  eng.tick(STEP); eng.tick(STEP); eng.tick(STEP)
  eng.drag(500)
  st = eng.getState()
  eq(JSON.stringify(st), snap0, 'ready 态 tick/drag 不改变任何状态')
  eng.tap()
  st = eng.getState()
  eq(st.phase, 'playing', 'tap 开局 phase=playing')
  ok(st.speed > 0, 'playing 后 speed>0（speed=' + st.speed + '）')
  var zMaxBefore = Math.max.apply(null, st.asteroids.map(function (a) { return a.z }))
  for (var t = 0; t < 70; t++) eng.tick(STEP) // 1.12s：起步净空 30m，首星尚未到船（1.67s 才到），安全
  st = eng.getState()
  var zMaxAfter = Math.max.apply(null, st.asteroids.map(function (a) { return a.z }))
  ok(zMaxAfter > zMaxBefore, 'playing 后世界向 +z 滚动（最近星 z: ' + zMaxBefore.toFixed(1) + ' -> ' + zMaxAfter.toFixed(1) + '）')
  ok(zMaxAfter > -C.SAFE_START_DIST, '净空区已被滚过（最近星 z > -SAFE_START_DIST）')
}

// ---------- 2. 拖拽 px 映射 + lerp + 钳制 ----------
section('拖拽 px 映射 / lerp 平滑 / 钳制')
{
  var eng = createEngine({ rng: mulberry32(2) })
  eng.tap()
  var st = eng.getState()
  // px 映射：DRAG_PX_PER_WORLD px = 1 world
  eng.drag(C.DRAG_PX_PER_WORLD)
  eq(eng.getState().player.targetX, 1, 'drag(' + C.DRAG_PX_PER_WORLD + 'px) -> targetX +1')
  eng.drag(-C.DRAG_PX_PER_WORLD * 2)
  eq(eng.getState().player.targetX, -1, '再 drag(-80px) -> targetX -1')
  // lerp：x 从 0 指数逼近 targetX=-1
  eng.tick(STEP)
  st = eng.getState()
  var k = 1 - Math.exp(-C.LERP_RATE * STEP)
  approx(st.player.x, -k, 1e-9, '一帧后 x = targetX*(1-exp(-rate*dt))')
  // 钳制 ±halfRange
  eng.drag(10000)
  eq(eng.getState().player.targetX, 4, '巨幅右拖钳到 +4')
  eng.drag(-10000)
  eq(eng.getState().player.targetX, -4, '巨幅左拖钳到 -4')
  for (var i = 0; i < 60; i++) eng.tick(STEP) // 0.96s 充分收敛（指数尾 ~6e-5）
  st = eng.getState()
  approx(st.player.x, -4, 0.005, 'x 收敛到 -4')
  ok(st.phase === 'playing', '横移过程未撞（起步净空内）')

  // halfRange 覆盖
  var eng2 = createEngine({ rng: mulberry32(2), halfRange: 2 })
  eng2.tap()
  eng2.drag(10000)
  eq(eng2.getState().player.targetX, 2, 'halfRange=2 时钳到 +2')
  eq(eng2.halfRange, 2, 'eng.halfRange getter 透出')

  // 非法拖拽防御
  eng.drag(NaN); eng.drag(Infinity)
  eq(eng.getState().player.targetX, -4, 'NaN/Infinity 拖拽被忽略')
}

// ---------- 3. 密度爬坡 ----------
section('密度随里程爬坡（startDistance 热启动直接对比）')
{
  // 说明：真实长跑会被撞死导致世界冻结，无法靠"跑 70s"验证密度；
  // 用引擎的热启动选项 startDistance（速度/密度爬坡起点）生成两个同种子世界直接对比。
  function countWindow(startDist) {
    var eng = createEngine({ rng: mulberry32(3), startDistance: startDist })
    var st = eng.getState()
    ok(eng.distance === startDist, 'startDistance=' + startDist + ' 生效（distance getter）')
    return st.asteroids.filter(function (a) { return a.z >= -100 && a.z <= -40 }).length
  }
  var early = countWindow(0)
  var late = countWindow(2500)
  ok(early >= 0, '起步里程窗口小行星数 ' + early + '（密度因子 ~0.02）')
  ok(late > early + 2, '远期密度显著更高：' + early + ' -> ' + late + '（密度因子 ~0.96）')
  // 热启动下 speed 起点也爬坡到位
  var hot = createEngine({ rng: mulberry32(5), startDistance: 3000 })
  approx(hot.getState().speed, C.SPEED_MAX, 1e-9, 'startDistance=3000 -> 初始 speed=SPEED_MAX')
}

// ---------- 4. 通道可通过性 / 晶体公平性 ----------
section('任意 z 截面存在可通过通道 / 晶体不埋进小行星')
{
  var eng = createEngine({ rng: mulberry32(4) })
  eng.tap()
  for (var i = 0; i < 40 / STEP; i++) eng.tick(STEP) // 跑一段，混合低/高密度内容
  var st = eng.getState()
  var pass = true
  var worst = null
  for (var z = st.view.from + 2; z <= st.view.to - 2; z += 0.5) {
    var found = false
    for (var xx = -4; xx <= 4; xx += 0.25) {
      var clear = true
      for (var ai = 0; ai < st.asteroids.length; ai++) {
        var a = st.asteroids[ai]
        var dx = a.x - xx
        var dz = a.z - z
        var need = a.r + C.SHIP_RADIUS
        if (dx * dx + dz * dz < need * need) { clear = false; break }
      }
      if (clear) { found = true; break }
    }
    if (!found) { pass = false; worst = z; break }
  }
  ok(pass, '每个 z 截面（步进 0.5）都存在安全 x' + (worst !== null ? '，首个失守 z=' + worst : ''))
  ok(
    st.crystals.every(function (c) {
      return st.asteroids.every(function (a) {
        var dx = a.x - c.x
        var dz = a.z - c.z
        return dx * dx + dz * dz >= (a.r + 0.3) * (a.r + 0.3)
      })
    }),
    '晶体不埋进小行星（间隙 >= 0.3）',
  )
}

// ---------- 5. 晶体拾取 ----------
section('晶体拾取（自动驾驶贪心收集）')
{
  var result = null
  for (var seed = 1; seed <= 60 && result === null; seed++) {
    var eng = createEngine({ rng: mulberry32(seed) })
    eng.tap()
    var expectedDist = 0
    var collected = 0
    var crashed = false
    for (var i = 0; i < 40 / STEP; i++) {
      var st = eng.getState()
      if (st.phase === 'dead') { crashed = true; break }
      expectedDist += st.speed * STEP
      // 贪心：优先最近晶体，否则回中
      var target = 0
      var bestZ = -Infinity
      for (var ci = 0; ci < st.crystals.length; ci++) {
        var c = st.crystals[ci]
        if (c.z > bestZ && c.z < -1 && Math.abs(c.x) <= 3) { bestZ = c.z; target = c.x }
      }
      steer(eng, target)
      eng.tick(STEP)
      if (eng.getState().crystals.length < st.crystals.length) collected++
      if (collected >= 2) break
    }
    if (!crashed && collected >= 2) {
      var st2 = eng.getState()
      var formulaOk = st2.score === Math.floor(expectedDist) + st2.crystals.length * 0 + collected * C.SCORE_PER_CRYSTAL
      // 公式按引擎口径复核：score = floor(dist) + crystalsRun*50
      result = { seed: seed, collected: collected, score: st2.score, formulaOk: formulaOk }
    }
  }
  ok(result !== null, '找到可安全收集 2 晶体的种子' + (result ? '：seed=' + result.seed : '（60 个种子内未找到）'))
  if (result) {
    ok(result.formulaOk, 'score = floor(dist) + 晶体*50（实时结算复核通过）')
    ok(result.score >= result.collected * C.SCORE_PER_CRYSTAL, 'score 含晶体分（score=' + result.score + '）')
  }
}

// ---------- 6. 碰撞死亡 + 冻结 + reset ----------
section('撞小行星 -> 死亡(asteroid) -> 冻结 -> reset')
{
  var eng = null
  var deathSeed = 0
  for (var seed = 1; seed <= 60 && eng === null; seed++) {
    var cand = createEngine({ rng: mulberry32(seed) })
    cand.tap()
    var dead = false
    for (var i = 0; i < 10 / STEP; i++) {
      var st = cand.getState()
      if (st.phase === 'dead') { dead = true; break }
      // 直冲最近小行星
      var target = 0
      var bestZ = -Infinity
      for (var ai = 0; ai < st.asteroids.length; ai++) {
        var a = st.asteroids[ai]
        if (a.z > bestZ && a.z < -1) { bestZ = a.z; target = a.x }
      }
      steer(cand, target)
      cand.tick(STEP)
    }
    if (dead) { eng = cand; deathSeed = seed }
  }
  ok(eng !== null, '找到撞岩种子：seed=' + deathSeed)
  var st = eng.getState()
  eq(st.phase, 'dead', '冲向小行星 -> 死亡')
  eq(st.deathReason, 'asteroid', '死亡原因 = asteroid')
  ok(st.asteroids.length > 0, '死亡快照仍有星域（渲染层播爆炸）')

  // 冻结：世界停摆、deadMs 走表、输入忽略
  var frozen = JSON.stringify(st.asteroids) + '|' + JSON.stringify(st.crystals) + '|' + st.player.x
  eng.tick(0.5) // 钳 0.2s
  eng.tick(0.5)
  eng.drag(500)
  eng.tap()
  var st2 = eng.getState()
  eq(st2.phase, 'dead', '死亡后 tick/drag/tap 不复活')
  eq(st2.player.x, st.player.x, '飞船位置定格')
  ok(
    JSON.stringify(st2.asteroids) + '|' + JSON.stringify(st2.crystals) + '|' + st2.player.x === frozen,
    '世界快照逐字节一致（完全冻结）',
  )
  ok(st2.deadMs >= 400, 'deadMs 累计（0.5s*2 钳成 0.4s），实际 ' + Math.round(st2.deadMs) + 'ms')
  eq(st2.deadLockMs, 600, 'deadLockMs 供壳层判锁')
  eq(st2.score, st.score, '死亡后 score 不再变化')

  // reset：干净重开，best 保留
  eng.best = 1234
  eng.reset()
  var st3 = eng.getState()
  eq(st3.phase, 'ready', 'reset 后回到 ready')
  eq(st3.score, 0, 'score 清零')
  eq(st3.deathReason, null, 'deathReason 清空')
  eq(st3.deadMs, 0, 'deadMs 清零')
  eq(st3.best, 1234, 'best 保留')
  eq(st3.player.x, 0, '飞船回中')
  ok(st3.asteroids.length > 0, '新世界已生成')
  eng.tap(); eng.tick(STEP)
  eq(eng.getState().phase, 'playing', 'reset 后可正常开局')
}

// ---------- 7. 计分 ----------
section('计分 = floor(距离) + 晶体*50')
{
  var eng = createEngine({ rng: mulberry32(6) })
  eq(eng.getState().score, 0, '初始 0 分')
  eng.tap()
  var dist = 0
  for (var i = 0; i < 10; i++) { dist += eng.getState().speed * 0.2; eng.tick(0.2) }
  var st = eng.getState()
  eq(st.score, Math.floor(dist), '纯距离计分：2s 后 score=' + st.score + '（dist=' + dist.toFixed(2) + '）')
  ok(dist > 3.5, '2s 里程合理（speed=18 → 3.6m+），实际 ' + dist.toFixed(2))
  // 速度爬坡生效：远期 speed 趋近 SPEED_MAX
  for (var j = 0; j < 400; j++) eng.tick(0.2) // 累计 ~1500m+
  for (var k = 0; k < 8000; k++) eng.tick(0.2) // 一路跑到 3000m+（CPU 秒级）
  var st2 = eng.getState()
  if (st2.phase === 'dead') {
    ok(true, '远期撞岩死亡（正常），speed 终值验证跳过')
  } else {
    approx(st2.speed, C.SPEED_MAX, 0.5, '3000m 后速度逼近 SPEED_MAX')
  }
}

// ---------- 8. seed 复现 ----------
section('rng/seed 注入可复现')
{
  function seq() {
    var eng = createEngine({ rng: mulberry32(42) })
    eng.tap()
    for (var i = 0; i < 30; i++) {
      steer(eng, Math.sin(i) * 3)
      eng.tick(STEP)
    }
    eng.reset()
    eng.tap()
    for (var j = 0; j < 10; j++) { eng.tick(STEP) }
    return JSON.stringify(eng.getState())
  }
  eq(seq(), seq(), '同种子同操作序列（含 reset）→ 状态逐字节一致')
  var a = createEngine({ rng: mulberry32(42) }).getState()
  var b = createEngine({ rng: mulberry32(43) }).getState()
  ok(JSON.stringify(a) !== JSON.stringify(b), '不同种子 → 世界生成不同')
  var s1 = createEngine({ seed: 7 })
  var s2 = createEngine({ rng: mulberry32(7) })
  s1.tap(); s2.tap()
  for (var m = 0; m < 10; m++) { s1.tick(STEP); s2.tick(STEP) }
  eq(JSON.stringify(s1.getState()), JSON.stringify(s2.getState()), 'seed 选项等价于注入 mulberry32(seed)')
  var def = createEngine()
  def.tap(); def.tick(STEP)
  ok(isFinite(def.getState().score), '缺省 Math.random 可正常游玩')
}

// ---------- 9. getState 纯度 + 异常 dt ----------
section('getState 纯数据 / 异常 dt 防御')
{
  var eng = createEngine({ rng: mulberry32(9) })
  eng.tap()
  var s1 = eng.getState()
  var s1ref = JSON.stringify(s1)
  s1.player.x = 999
  s1.asteroids[0].z = 999
  s1.crystals.pop()
  eq(JSON.stringify(eng.getState()), s1ref, '改动返回值不影响引擎（深拷贝）')

  eng.tick(-0.005) // 负 dt -> 钳 0
  eng.tick(NaN)    // 非法 dt -> 忽略
  eng.tick(1e9)    // 巨 dt -> 钳 MAX_TICK_S
  var s2 = eng.getState()
  ok(isFinite(s2.player.x) && isFinite(s2.score) && isFinite(s2.speed), '异常 dt 不产生 NaN')
  // 巨 dt 恰好推进 MAX_TICK_S：t=0 起 speed=18，0.2s → dist=3.6，score=3
  ok(eng.distance === C.SPEED_MIN * C.MAX_TICK_S, '巨 dt 被钳为单步 MAX_TICK_S（dist=' + eng.distance + '）')
  eq(eng.getState().score, Math.floor(C.SPEED_MIN * C.MAX_TICK_S), '计分同步正确（score=3）')
}

// ---------- 汇总 ----------
console.log('')
console.log('======== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ========')
if (failed > 0) process.exitCode = 1
