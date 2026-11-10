'use strict';

/**
 * Flappy Bird · 游戏引擎（engine-dev）
 *
 * 纯逻辑：零 wx.*、零 canvas、零 storage 依赖，node 可独立跑冒烟测试。
 * 状态机：ready → playing → (dying →) over → reset → ready
 *   - playing 撞管 → dying（管与地停滚，鸟坠落+rot→π/2，触地 → over）
 *   - playing 撞地 → 直接 over
 *
 * 手感设计（对齐原版 Flappy Bird）：
 *   - flap 立即响应：vy 直接置为 FLAP_VY，rot 立刻抬到 -0.44，无插值延迟
 *   - 下落时鸟头延迟后转向俯冲（vy 超过阈值才开始向 +π/2 转），接近原版的「先悬后栽」
 *   - 撞管瞬间给一个小上跳（0.4×FLAP_VY），坠落弧线更自然
 *   - 顶部不可越过（y 钳在碰撞半径处），杜绝从管子上方溜过去
 */

const { PHYS } = require('./constants');

// —— 引擎内部手感常量（不属于契约 PHYS，字段名可自由命名） ——
const READY_BASE_Y = 0.42;      // ×h ready 悬停基线
const READY_AMP = 0.012;        // ×h ready 正弦浮动幅度
const READY_PERIOD = 1.6;       // s  ready 浮动周期
const READY_ROTSWAY = 0.05;     // rad ready 姿态轻微摇摆
const ROT_UP = -0.44;           // rad 上升姿态（契约值）
const ROT_DOWN = Math.PI / 2;   // rad 俯冲/坠落终态
const ROT_FALL_THRESHOLD = 0.18;// ×MAX_FALL 超过此下落速度才开始低头
const ROT_DOWN_SPEED = 4.6;     // rad/s playing 下落低头角速度
const ROT_DYING_SPEED = 8.0;    // rad/s dying 坠落转头角速度（更快，摔感）
const HIT_POP = 0.4;            // ×FLAP_VY 撞管瞬间的小上跳
const GAP_MARGIN_TOP = 0.11;    // ×h 缝中心距屏幕顶的最小留白
const GAP_MARGIN_BOTTOM = 0.11; // ×h 缝中心(下半缝)距地面的最小留白
const GAP_MAX_DELTA = 0.30;     // ×h 相邻两根管缝中心的最大跳变限幅（公平性：杜绝不可达跳变）
const PIPE_TAIL_MARGIN = 4;     // px  管完全移出屏幕左缘的余量
const GROUND_WRAP = 240;        // px  groundOffset 取模周期（兼容 8/10/12/15/16/20/24/30/40/48/60 的沙纹周期）
const CLOUD_COUNT = 4;
const CLOUD_BAND_TOP = 0.06;    // ×h 云带顶部
const CLOUD_BAND_BOTTOM = 0.38; // ×h 云带底部
const CLOUD_SIZE = 0.14;        // ×h 云的估算宽度基准（scale=1，供环绕判定）
const DT_CAP = 0.05;            // s  与 shell 双保险（契约：shell 侧也 cap 0.05）

function createEngine(w, h) {
  // —— 派生尺寸（逻辑坐标 = css px） ——
  const groundY = h - PHYS.GROUND_H * h;
  const birdX = PHYS.BIRD_X * w;
  const birdR = PHYS.BIRD_R * h;
  const pipeW = Math.max(48, PHYS.PIPE_W * w); // 契约：管宽下限 48px 由 engine clamp
  const gap = PHYS.PIPE_GAP * h;
  const spacing = PHYS.PIPE_SPACING * w;
  const speed = PHYS.SPEED * w;
  const gravity = PHYS.GRAVITY * h;
  const flapVy = PHYS.FLAP_VY * h;
  const maxFall = PHYS.MAX_FALL * h;
  const readyBaseY = READY_BASE_Y * h;
  const readyAmp = READY_AMP * h;

  // 缝中心 y 的随机带（保证上/下各留 GAP_MARGIN，任何缝都可通过）
  const gapMinC = h * GAP_MARGIN_TOP + gap / 2;
  const gapMaxC = groundY - h * GAP_MARGIN_BOTTOM - gap / 2;

  // —— 状态 ——
  let phase = 'ready';
  let score = 0;
  let overAt = null;
  let floatT = 0;              // ready 浮动相位（s），reset 保留以避免姿态跳变
  let lastGapY = null;         // 上一根管的缝中心（用于跳变限幅）
  const bird = { x: birdX, y: readyBaseY, vy: 0, rot: 0 };
  const pipes = [];            // [{ x, gapY, passed }]
  const clouds = [];

  function spawnCloud(initial) {
    const scale = 0.55 + Math.random() * 0.6; // 0.55 ~ 1.15
    const estW = CLOUD_SIZE * h * scale;
    clouds.push({
      x: initial ? Math.random() * w : w + estW + Math.random() * w * 0.5,
      y: h * (CLOUD_BAND_TOP + Math.random() * (CLOUD_BAND_BOTTOM - CLOUD_BAND_TOP)),
      scale,
      speed: w * (0.012 + Math.random() * 0.02), // px/s，慢速视差
    });
  }
  for (let i = 0; i < CLOUD_COUNT; i++) spawnCloud(true);

  function spawnPipe(x) {
    let gapY = gapMaxC > gapMinC
      ? gapMinC + Math.random() * (gapMaxC - gapMinC)
      : h * 0.45; // 极小屏兜底
    if (lastGapY !== null && gapMaxC > gapMinC) {
      // 相邻缝跳变限幅（公平性）：跳变过大的缝连人带机器人都不可达
      const maxDelta = GAP_MAX_DELTA * h;
      gapY = Math.max(lastGapY - maxDelta, Math.min(lastGapY + maxDelta, gapY));
      gapY = Math.max(gapMinC, Math.min(gapMaxC, gapY)); // 限幅后重新夹回合法带
    }
    lastGapY = gapY;
    pipes.push({ x, gapY, passed: false });
  }

  // 圆 vs 轴对齐矩形
  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const px = Math.max(rx, Math.min(cx, rx + rw));
    const py = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - px;
    const dy = cy - py;
    return dx * dx + dy * dy < r * r;
  }

  function hitPipe() {
    for (let i = 0; i < pipes.length; i++) {
      const p = pipes[i];
      if (p.x > bird.x + birdR || p.x + pipeW < bird.x - birdR) continue;
      const gapTop = p.gapY - gap / 2;
      const gapBottom = p.gapY + gap / 2;
      if (circleRect(bird.x, bird.y, birdR, p.x, -h, pipeW, gapTop + h)) return true;      // 上管
      if (circleRect(bird.x, bird.y, birdR, p.x, gapBottom, pipeW, groundY - gapBottom + h)) return true; // 下管
    }
    return false;
  }

  function enterOver() {
    phase = 'over';
    overAt = Date.now();
    bird.y = groundY - birdR; // 安放在地面上
    bird.vy = 0;
    bird.rot = ROT_DOWN;
  }

  const eng = {
    // phase/score/overAt 用 getter 透出，保证外部读到的永远是最新内部状态
    get phase() { return phase; },
    get score() { return score; },
    get overAt() { return overAt; },
    groundY,
    groundOffset: 0,
    bird,
    pipes,
    clouds,
    // 派生尺寸透出：renderer 必须用 eng.pipeW/eng.gap/eng.birdR 画，
    // 才能和碰撞判定（含 48px clamp）完全一致。只读约定。
    pipeW,
    gap,
    birdR,

    flap() {
      if (phase === 'ready') {
        phase = 'playing';
        pipes.length = 0;
        spawnPipe(w * 1.4); // 首根管留准备距离（契约值）
        bird.vy = flapVy;   // 跳跃立即响应：速度与姿态同帧生效
        bird.rot = ROT_UP;
      } else if (phase === 'playing') {
        bird.vy = flapVy;
        bird.rot = ROT_UP;
      }
      // dying / over：忽略
    },

    reset() {
      phase = 'ready';
      score = 0;
      pipes.length = 0;
      lastGapY = null; // 清跳变链，新一局首管不受限
      bird.x = birdX;
      bird.y = readyBaseY;
      bird.vy = 0;
      bird.rot = 0;
      // clouds 保留（契约：reset 回 ready 保留云）
    },

    tick(dtSec) {
      dtSec = Number(dtSec);
      if (!isFinite(dtSec) || dtSec <= 0) return; // 脏帧防御
      const dt = Math.min(dtSec, DT_CAP);

      // 云：所有阶段都缓慢漂移（背景氛围，与死亡冻结不冲突）
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.x -= c.speed * dt;
        const estW = CLOUD_SIZE * h * c.scale;
        if (c.x < -estW - 20) {
          clouds.splice(i, 1);
          spawnCloud(false);
          i--;
        }
      }

      if (phase === 'ready') {
        floatT += dt;
        bird.y = readyBaseY + Math.sin((floatT * Math.PI * 2) / READY_PERIOD) * readyAmp;
        bird.rot = Math.sin((floatT * Math.PI * 2) / READY_PERIOD) * READY_ROTSWAY;
        eng.groundOffset = (eng.groundOffset + speed * dt) % GROUND_WRAP;
        return;
      }

      if (phase === 'playing') {
        // 物理：半隐式欧拉 + 下落钳制
        bird.vy = Math.min(bird.vy + gravity * dt, maxFall);
        bird.y += bird.vy * dt;
        if (bird.y < birdR) { bird.y = birdR; if (bird.vy < 0) bird.vy = 0; } // 顶部不可越

        // 姿态：上升已由 flap 置 -0.44；持续下落超过阈值后低头俯冲
        if (bird.vy > maxFall * ROT_FALL_THRESHOLD && bird.rot < ROT_DOWN) {
          bird.rot = Math.min(bird.rot + ROT_DOWN_SPEED * dt, ROT_DOWN);
        }

        // 管：移动 → 移除出屏 → 尾部补管（屏内+1 根）
        for (let i = 0; i < pipes.length; i++) pipes[i].x -= speed * dt;
        while (pipes.length && pipes[0].x + pipeW < -PIPE_TAIL_MARGIN) pipes.shift();
        while (!pipes.length || pipes[pipes.length - 1].x < w + pipeW) {
          spawnPipe(pipes.length ? pipes[pipes.length - 1].x + spacing : w * 1.4);
        }

        // 计分：管尾缘越过鸟即得一分
        for (let i = 0; i < pipes.length; i++) {
          const p = pipes[i];
          if (!p.passed && p.x + pipeW < bird.x) {
            p.passed = true;
            score++;
          }
        }

        eng.groundOffset = (eng.groundOffset + speed * dt) % GROUND_WRAP;

        // 碰撞：先管后地（撞地直接 over，契约）
        if (hitPipe()) {
          phase = 'dying';
          bird.vy = Math.min(bird.vy, flapVy * HIT_POP); // 小上跳后坠落
          return;
        }
        if (bird.y + birdR >= groundY) {
          enterOver();
        }
        return;
      }

      if (phase === 'dying') {
        // 管与地停滚；鸟继续坠落 + 快速转头俯冲
        bird.vy = Math.min(bird.vy + gravity * dt, maxFall);
        bird.y += bird.vy * dt;
        if (bird.y < birdR) bird.y = birdR;
        if (bird.rot < ROT_DOWN) bird.rot = Math.min(bird.rot + ROT_DYING_SPEED * dt, ROT_DOWN);
        if (bird.y + birdR >= groundY) enterOver();
        return;
      }

      // over：全静止，无操作
    },
  };

  return eng;
}

module.exports = { createEngine };
