/**
 * flappy-bird · src/renderer.js —— render-dev（契约 v1）
 *
 * 职责：每帧全量重绘，绘制顺序按契约：
 *   天空渐变 → (dark 星星) → 云 → 管道(管身+描边+上下管唇+左侧高光条) → 鸟 → 地面(草沿+沙纹) → UI
 * 约束：无自身状态、不读 storage、不碰 wx.*；颜色只取 pal 字段，零硬编码色值；
 *       圆角矩形手写 arcTo path；描边文字用 strokeText(lineWidth≈字号/7, 先 stroke 后 fill)；
 *       bezierCurveTo 每次都传满 6 参数。
 *
 * 导出：
 *   draw(ctx, eng, pal, w, h, nowMs)
 *   buttonRect(w, h) → { x, y, w, h }   // over 面板「再来一局」按钮命中区
 *
 * 注：渲染层会读可选字段 eng.best（历史最高分）用于徽章/面板展示；
 *     shell 在 createEngine 后与 saveBest 后把它塞进 eng.best 即可，缺省按 0 展示。
 */

// ---- 物理常量：优先用 engine-dev 的 constants.js（字段名契约固定）；
//      并行开发期文件未落地/暂不可用时，回落到契约 v1 数值，保证本文件可独立 node 冒烟 ----
var PHYS = {
  GROUND_H: 0.115, BIRD_X: 0.28, BIRD_R: 0.026, BIRD_VIS: 0.045,
  PIPE_W: 0.155, PIPE_GAP: 0.185, PIPE_SPACING: 0.62,
  SPEED: 0.50, GRAVITY: 2.40, FLAP_VY: -0.72, MAX_FALL: 1.35, RESTART_DELAY: 500
};
var MEDAL = { GOLD_AT: 60, SILVER_AT: 30, BRONZE_AT: 10 };
try {
  var _constants = require('./constants.js');
  if (_constants && _constants.PHYS) PHYS = _constants.PHYS;
  if (_constants && _constants.MEDAL) MEDAL = _constants.MEDAL;
} catch (e) { /* 用上面的契约默认值 */ }

var TAU = Math.PI * 2;

// ---------------- 小工具 ----------------

function isNum(v) { return typeof v === 'number' && isFinite(v); }

function pickNum(v, fb) { return isNum(v) ? v : fb; }

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function mod(v, m) { return ((v % m) + m) % m; }

function frac1(n) { return n - Math.floor(n); }

/** 圆角矩形路径：手写 arcTo（5 参）。调用方自行 beginPath / fill / stroke。 */
function roundRectPath(ctx, x, y, rw, rh, r) {
  var rr = clamp(r, 0, Math.min(rw, rh) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + rw, y, x + rw, y + rh, rr);
  ctx.arcTo(x + rw, y + rh, x, y + rh, rr);
  ctx.arcTo(x, y + rh, x, y, rr);
  ctx.arcTo(x, y, x + rw, y, rr);
  ctx.closePath();
}

/** 椭圆路径：4 段 bezier 逼近，bezierCurveTo 一律 6 参数。调用方先 beginPath。 */
function ellipsePath(ctx, cx, cy, rx, ry) {
  var k = 0.5522847498307936;
  var kx = rx * k, ky = ry * k;
  ctx.moveTo(cx + rx, cy);
  ctx.bezierCurveTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
  ctx.bezierCurveTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
  ctx.bezierCurveTo(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
  ctx.bezierCurveTo(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
  ctx.closePath();
}

/** 描边文字：strokeText 后 fillText，lineWidth ≈ 字号/7，圆 join 防毛刺。 */
function outlinedText(ctx, text, x, y, fs, fill, stroke, align, baseline) {
  ctx.save();
  ctx.font = 'bold ' + fs + 'px sans-serif';
  ctx.textAlign = align || 'center';
  ctx.textBaseline = baseline || 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, fs / 7);
  if (stroke) { ctx.strokeStyle = stroke; ctx.strokeText(text, x, y); }
  if (fill) { ctx.fillStyle = fill; ctx.fillText(text, x, y); }
  ctx.restore();
}

/** 无描边普通文字。 */
function plainText(ctx, text, x, y, fs, fill, bold, align, baseline) {
  ctx.save();
  ctx.font = (bold ? 'bold ' : '') + fs + 'px sans-serif';
  ctx.textAlign = align || 'center';
  ctx.textBaseline = baseline || 'middle';
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** 估宽：优先 measureText，mock/异常时按字符宽度估算（CJK≈1.0×fs，ASCII≈0.58×fs）。 */
function textWidth(ctx, text, fs, bold) {
  var out = 0;
  try {
    ctx.font = (bold ? 'bold ' : '') + fs + 'px sans-serif';
    var m = ctx.measureText ? ctx.measureText(text) : null;
    if (m && isNum(m.width) && m.width > 0) out = m.width;
  } catch (e) { out = 0; }
  if (!out) {
    var c = 0;
    for (var i = 0; i < text.length; i++) c += text.charCodeAt(i) > 255 ? 1.0 : 0.58;
    out = c * fs;
  }
  return out;
}

/** 地面顶 y：优先 eng.groundY，兜底按契约比例。 */
function groundTop(eng, w, h) {
  var gy = pickNum(eng && eng.groundY, h * (1 - PHYS.GROUND_H));
  return clamp(gy, h * 0.5, h);
}

/** over 面板布局：draw 与 buttonRect 共用同一份几何，保证命中区与视觉一致。 */
function panelLayout(w, h) {
  var pw = w * 0.78;
  var px = (w - pw) / 2;
  var py = h * 0.28;
  var ph = h * 0.36;
  var bw = pw * 0.52;
  var bh = h * 0.058;
  var bx = (w - bw) / 2;
  var by = py + ph - bh - h * 0.03;
  return { pw: pw, px: px, py: py, ph: ph, bw: bw, bh: bh, bx: bx, by: by };
}

// ---------------- 场景件 ----------------

function drawSky(ctx, pal, w, h, gy) {
  var g = ctx.createLinearGradient(0, 0, 0, gy);
  g.addColorStop(0, pal.skyTop);
  g.addColorStop(1, pal.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** dark 星空：确定性伪随机 frac(sin(i*127.1)*43758.5453)，26 颗，只画天空区；light 的 pal.star=null 自动跳过。 */
function drawStars(ctx, pal, w, h, gy, nowMs) {
  if (!pal.star) return;
  ctx.save();
  ctx.fillStyle = pal.star;
  for (var i = 0; i < 26; i++) {
    var fx = frac1(Math.sin(i * 127.1) * 43758.5453);
    var fy = frac1(Math.sin(i * 311.7 + 1.3) * 12543.1379);
    var x = fx * w;
    var y = (0.04 + fy * 0.72) * gy;
    var r = 0.8 + fy * 1.5;
    ctx.globalAlpha = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(nowMs / 650 + i * 2.13));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** 视差云：三瓣椭圆并成一个 path 一次 fill，避免半透明叠出深色交叠。 */
function drawClouds(ctx, eng, pal, w, h) {
  var clouds = (eng && eng.clouds) || [];
  if (!clouds.length || !pal.cloud) return;
  ctx.save();
  ctx.fillStyle = pal.cloud;
  for (var i = 0; i < clouds.length; i++) {
    var c = clouds[i];
    var s = pickNum(c && c.scale, 1);
    var r = Math.max(6, 15 * s * (h / 700));
    var cx = pickNum(c && c.x, w * 0.5);
    var cy = pickNum(c && c.y, h * 0.2);
    ctx.beginPath();
    ellipsePath(ctx, cx, cy, r * 1.35, r * 0.85);
    ellipsePath(ctx, cx + r * 1.15, cy + r * 0.22, r * 0.85, r * 0.6);
    ellipsePath(ctx, cx - r * 1.15, cy + r * 0.26, r * 0.7, r * 0.5);
    ctx.fill();
  }
  ctx.restore();
}

/** 半根管道：管身 → 左侧高光条 → 管身描边 → 缝端管唇（略宽出、圆角小、描边）。 */
function pipeHalf(ctx, pal, x, y, ph, pw, lipH, ov, hiW, hiX, lw, isTop) {
  if (ph <= 0) return;
  // 管身
  ctx.fillStyle = pal.pipeBody;
  ctx.fillRect(x, y, pw, ph);
  // 左侧高光条（避开管唇，贴在管身内侧）
  ctx.fillStyle = pal.pipeHi;
  var hy = isTop ? y + 2 : y + lipH + 1;
  ctx.fillRect(x + hiX, hy, hiW, Math.max(0, ph - lipH - 3));
  // 管身描边
  ctx.strokeStyle = pal.pipeEdge;
  ctx.lineWidth = lw;
  ctx.strokeRect(x + lw / 2, y + lw / 2, pw - lw, ph - lw / 2);
  // 管唇（缝端一圈加宽边）
  var ly = isTop ? (y + ph - lipH) : y;
  roundRectPath(ctx, x - ov, ly, pw + ov * 2, lipH, Math.min(4, lipH / 2));
  ctx.fillStyle = pal.pipeLip;
  ctx.fill();
  ctx.strokeStyle = pal.pipeEdge;
  ctx.stroke();
}

function drawPipes(ctx, eng, pal, w, h, gy) {
  var pipes = (eng && eng.pipes) || [];
  if (!pipes.length) return;
  // 管宽/缝高一律读 engine 透出的派生尺寸（eng.pipeW 已含 48px clamp、eng.gap），
  // 保证视觉与碰撞判定永远同口径；eng 缺字段时才回落 PHYS 公式。
  var pw = pickNum(eng && eng.pipeW, Math.max(PHYS.PIPE_W * w, 48));
  var gapH = pickNum(eng && eng.gap, PHYS.PIPE_GAP * h);
  var lipH = Math.max(9, pw * 0.15);
  var ov = Math.max(4, pw * 0.055);
  var hiW = Math.max(4, pw * 0.13);
  var hiX = pw * 0.12;
  var lw = Math.max(2, w * 0.006);
  for (var i = 0; i < pipes.length; i++) {
    var p = pipes[i];
    if (!p || !isNum(p.x) || !isNum(p.gapY)) continue;
    if (p.x + pw < -2 || p.x > w + 2) continue;
    var topH = clamp(p.gapY - gapH / 2, 0, gy);   // 上管底
    var botY = clamp(p.gapY + gapH / 2, 0, gy);   // 下管顶
    pipeHalf(ctx, pal, p.x, -4, topH + 4, pw, lipH, ov, hiW, hiX, lw, true);
    pipeHalf(ctx, pal, p.x, botY, gy - botY + 4, pw, lipH, ov, hiW, hiX, lw, false);
  }
}

/** 鸟：身体椭圆+描边、白肚下半（clip 在身体内）、扇动翅膀、右上瞳白眼、橙嘴；整体随 eng.bird.rot 旋转。 */
function drawBird(ctx, eng, pal, w, h, nowMs) {
  var b = (eng && eng.bird) || {};
  var bx = pickNum(b.x, w * PHYS.BIRD_X);
  var by = pickNum(b.y, h * 0.42);
  var rot = pickNum(b.rot, 0);
  var r = Math.max(10, PHYS.BIRD_VIS * h);
  var rx = r, ry = r * 0.82;
  var frozen = !!eng && (eng.phase === 'dying' || eng.phase === 'over');
  var flap = frozen ? 0 : Math.sin(nowMs / 90); // dying/over 定格

  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(rot);

  // 身体底色
  ctx.beginPath();
  ellipsePath(ctx, 0, 0, rx, ry);
  ctx.fillStyle = pal.birdBody;
  ctx.fill();

  // 白肚（下半，裁在身体轮廓内）
  ctx.save();
  ctx.beginPath();
  ellipsePath(ctx, 0, 0, rx, ry);
  ctx.clip();
  ctx.fillStyle = pal.birdBelly;
  ctx.beginPath();
  ellipsePath(ctx, r * 0.05, r * 0.55, r * 0.80, r * 0.55);
  ctx.fill();
  ctx.restore();

  // 身体描边
  ctx.beginPath();
  ellipsePath(ctx, 0, 0, rx, ry);
  ctx.strokeStyle = pal.birdEdge;
  ctx.lineWidth = Math.max(2, r * 0.13);
  ctx.stroke();

  // 翅膀（nowMs 驱动上下扇动；dying/over 定格）
  ctx.save();
  ctx.translate(-r * 0.12, r * 0.18 + flap * r * 0.16);
  ctx.rotate(-0.45 + flap * 0.35);
  ctx.beginPath();
  ellipsePath(ctx, 0, 0, r * 0.58, r * 0.34);
  ctx.fillStyle = pal.birdWing;
  ctx.fill();
  ctx.restore();

  // 眼：白底 + 右上黑瞳 + 高光
  var ex = r * 0.42, ey = -r * 0.38, er = r * 0.34;
  ctx.beginPath();
  ctx.arc(ex, ey, er, 0, TAU);
  ctx.fillStyle = pal.hudText; // palette 里的白
  ctx.fill();
  ctx.strokeStyle = pal.birdEdge;
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ex + er * 0.30, ey - er * 0.25, er * 0.42, 0, TAU);
  ctx.fillStyle = pal.panelText; // palette 里最深的色，充当瞳孔
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex + er * 0.45, ey - er * 0.40, er * 0.15, 0, TAU);
  ctx.fillStyle = pal.hudText;
  ctx.fill();

  // 嘴（橙，圆角三角，细描边）
  ctx.beginPath();
  ctx.moveTo(r * 0.40, -r * 0.12);
  ctx.quadraticCurveTo(r * 1.34, -r * 0.06, r * 1.30, r * 0.14);
  ctx.quadraticCurveTo(r * 1.02, r * 0.34, r * 0.40, r * 0.20);
  ctx.closePath();
  ctx.fillStyle = pal.birdBeak;
  ctx.fill();
  ctx.strokeStyle = pal.birdEdge;
  ctx.lineWidth = Math.max(1.5, r * 0.08);
  ctx.stroke();

  ctx.restore();
}

/** 地面：沙底 + 沙纹（按 groundOffset 滚动）+ 草带 + 草沿（天侧 + 草沙交界）。 */
function drawGround(ctx, eng, pal, w, h, gy) {
  var gh = h - gy;
  if (gh <= 0) return;
  var grassH = clamp(gh * 0.30, 6, h * 0.05);
  var rim = clamp(gh * 0.10, 2, 5);

  // 沙底
  ctx.fillStyle = pal.sand;
  ctx.fillRect(0, gy, w, gh);

  // 沙纹：斜短线，随 groundOffset 无缝滚动
  var sp = Math.max(30, w * 0.10);
  var off = mod(pickNum(eng && eng.groundOffset, 0), sp);
  ctx.strokeStyle = pal.sandLine;
  ctx.lineWidth = Math.max(2, h * 0.005);
  ctx.beginPath();
  for (var x = -sp + off; x < w + sp; x += sp) {
    ctx.moveTo(x, gy + grassH + gh * 0.12);
    ctx.lineTo(x + sp * 0.42, h - gh * 0.12);
  }
  ctx.stroke();

  // 草带 + 草沿
  ctx.fillStyle = pal.grass;
  ctx.fillRect(0, gy, w, grassH);
  ctx.fillStyle = pal.grassEdge;
  ctx.fillRect(0, gy, w, rim);                            // 天侧草沿
  ctx.fillRect(0, gy + grassH - rim * 0.7, w, rim * 0.7); // 草沙交界
}

// ---------------- UI ----------------

function drawReadyUI(ctx, eng, pal, w, h, nowMs, best) {
  // 左上「最高分 ★ N」圆角徽章
  var fs = Math.max(11, h * 0.023);
  var label = '最高分 ★ ' + best;
  var tw = textWidth(ctx, label, fs, true);
  var bh = fs * 1.75;
  var bw = tw + fs * 1.5;
  roundRectPath(ctx, w * 0.03, h * 0.018, bw, bh, bh / 2);
  ctx.fillStyle = pal.badgeBg;
  ctx.fill();
  plainText(ctx, label, w * 0.03 + bw / 2, h * 0.018 + bh / 2, fs, pal.badgeText, true);

  // 居中大标题（白字 + 契约描边色）
  var tfs = Math.min(h * 0.065, w * 0.135);
  var lh = tfs * 1.06;
  var ty = h * 0.20;
  outlinedText(ctx, 'FLAPPY', w / 2, ty, tfs, pal.hudText, pal.hudStroke);
  outlinedText(ctx, 'BIRD', w / 2, ty + lh, tfs, pal.hudText, pal.hudStroke);

  // 「点按屏幕起飞」白底胶囊，呼吸闪烁 alpha = 0.5 + 0.5*sin(nowMs/400)
  var hfs = Math.max(12, h * 0.026);
  var hlabel = '点按屏幕起飞';
  var htw = textWidth(ctx, hlabel, hfs, true);
  var hh = hfs * 1.8;
  var hw = htw + hfs * 2.2;
  var hx = (w - hw) / 2;
  var hy = h * 0.345 - hh / 2;
  ctx.save();
  ctx.globalAlpha = 0.5 + 0.5 * Math.sin(nowMs / 400);
  roundRectPath(ctx, hx, hy, hw, hh, hh / 2);
  ctx.fillStyle = pal.hintBg;
  ctx.fill();
  plainText(ctx, hlabel, w / 2, hy + hh / 2, hfs, pal.hintText, true);
  ctx.restore();
}

/** 奖牌圆章（挂件样式，压在面板右上角）：≥金/银/铜阈值才画，缎带用按钮橙（pal 内既有色）。 */
function drawMedal(ctx, pal, w, h, score) {
  var medal = null;
  if (score >= MEDAL.GOLD_AT) medal = { body: pal.medalGold, edge: pal.medalGoldEdge };
  else if (score >= MEDAL.SILVER_AT) medal = { body: pal.medalSilver, edge: pal.medalSilverEdge };
  else if (score >= MEDAL.BRONZE_AT) medal = { body: pal.medalBronze, edge: pal.medalBronzeEdge };
  if (!medal) return;

  var L = panelLayout(w, h);
  var mr = Math.max(18, Math.min(L.pw, L.ph) * 0.145);
  var mx = L.px + L.pw - mr * 0.30; // 大半压出面板右上角，挂件感
  var my = L.py - mr * 0.10;

  // 缎带：两根向上的斜条
  for (var s = -1; s <= 1; s += 2) {
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(s * 0.55);
    roundRectPath(ctx, -mr * 0.13, -mr * 1.55, mr * 0.26, mr * 1.0, mr * 0.08);
    ctx.fillStyle = pal.btnBg;
    ctx.fill();
    ctx.strokeStyle = pal.btnEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // 章体 + 描边 + 内环 + ★
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, TAU);
  ctx.fillStyle = medal.body;
  ctx.fill();
  ctx.strokeStyle = medal.edge;
  ctx.lineWidth = Math.max(2, mr * 0.11);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx, my, mr * 0.66, 0, TAU);
  ctx.strokeStyle = medal.edge;
  ctx.lineWidth = Math.max(1.5, mr * 0.05);
  ctx.stroke();
  plainText(ctx, '★', mx, my + mr * 0.04, mr * 0.9, medal.edge, true);
}

function drawOverUI(ctx, eng, pal, w, h, best) {
  var L = panelLayout(w, h);
  var score = Math.max(0, Math.floor(pickNum(eng && eng.score, 0)));

  // 全屏遮罩
  ctx.fillStyle = pal.mask;
  ctx.fillRect(0, 0, w, h);

  // 圆角面板
  roundRectPath(ctx, L.px, L.py, L.pw, L.ph, 14);
  ctx.fillStyle = pal.panelBg;
  ctx.fill();
  ctx.strokeStyle = pal.panelEdge;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // GAME OVER
  plainText(ctx, 'GAME OVER', L.px + L.pw / 2, L.py + L.ph * 0.17,
    Math.min(h * 0.040, w * 0.085), pal.panelText, true);

  // 本局得分
  plainText(ctx, '本局', L.px + L.pw / 2, L.py + L.ph * 0.36, h * 0.024, pal.panelText, false);
  plainText(ctx, String(score), L.px + L.pw / 2, L.py + L.ph * 0.52, h * 0.062, pal.panelText, true);

  // 历史最高 ★N
  plainText(ctx, '最高 ★ ' + best, L.px + L.pw / 2, L.py + L.ph * 0.68, h * 0.024, pal.panelText, false);

  // 奖牌挂件（右上角）
  drawMedal(ctx, pal, w, h, score);

  // 「再来一局」按钮（圆角 12、描边，命中区 = buttonRect）
  roundRectPath(ctx, L.bx, L.by, L.bw, L.bh, 12);
  ctx.fillStyle = pal.btnBg;
  ctx.fill();
  ctx.strokeStyle = pal.btnEdge;
  ctx.lineWidth = 2;
  ctx.stroke();
  plainText(ctx, '再来一局', L.bx + L.bw / 2, L.by + L.bh / 2, Math.max(13, h * 0.028), pal.btnText, true);
}

function drawUI(ctx, eng, pal, w, h, nowMs) {
  var phase = (eng && eng.phase) || 'ready';
  var best = Math.max(0, Math.floor(pickNum(eng && eng.best, 0) || 0));
  if (phase === 'ready') {
    drawReadyUI(ctx, eng, pal, w, h, nowMs, best);
  } else if (phase === 'playing' || phase === 'dying') {
    // 顶部居中大分数
    var score = Math.max(0, Math.floor(pickNum(eng && eng.score, 0)));
    outlinedText(ctx, String(score), w / 2, h * 0.10, h * 0.07, pal.hudText, pal.hudStroke);
  } else if (phase === 'over') {
    drawOverUI(ctx, eng, pal, w, h, best);
  }
}

// ---------------- 主入口 ----------------

function draw(ctx, eng, pal, w, h, nowMs) {
  if (!ctx || !pal) return;
  w = pickNum(w, 390);
  h = pickNum(h, 844);
  nowMs = pickNum(nowMs, 0);
  var gy = groundTop(eng, w, h);

  drawSky(ctx, pal, w, h, gy);          // 1 天空渐变
  drawStars(ctx, pal, w, h, gy, nowMs); // 2 dark 星空（light 自动跳过）
  drawClouds(ctx, eng, pal, w, h);      // 3 云
  drawPipes(ctx, eng, pal, w, h, gy);   // 4 管道
  drawBird(ctx, eng, pal, w, h, nowMs); // 5 鸟
  drawGround(ctx, eng, pal, w, h, gy);  // 6 地面
  drawUI(ctx, eng, pal, w, h, nowMs);   // 7 UI（按 phase 三态）
}

/** 「再来一局」按钮命中区（over 面板内），几何与 drawOverUI 共用 panelLayout。 */
function buttonRect(w, h) {
  var L = panelLayout(pickNum(w, 390), pickNum(h, 844));
  return { x: L.bx, y: L.by, w: L.bw, h: L.bh };
}

module.exports.draw = draw;
module.exports.buttonRect = buttonRect;
