'use strict';

/**
 * Flappy Bird · 全局常量（engine-dev）
 * 纯数据模块，零环境依赖，QuickJS / node 皆可直接 require。
 * 契约：CONTRACT.md —— PHYS 字段名不许改，数值可微调。
 */

// 物理与布局参数。横向量 ×w，纵向量 ×h，自动适配任意屏幕比例。
// PIPE_W 的 48px 下限由 engine 在 createEngine 里 clamp（契约约定）。
const PHYS = {
  GROUND_H: 0.115,      // ×h 地面总高（草+沙）
  BIRD_X: 0.28,         // ×w 鸟固定 x
  BIRD_R: 0.026,        // ×h 碰撞半径（宽容，小于视觉尺寸）
  BIRD_VIS: 0.045,      // ×h 视觉半径（身体椭圆长轴 ≈ ×h）
  PIPE_W: 0.155,        // ×w 管宽（下限 48px 由 engine clamp）
  PIPE_GAP: 0.195,      // ×h 缝高（原版 ≈0.195h，契约值 0.185 偏窄）
  PIPE_SPACING: 0.62,   // ×w 管水平间距
  SPEED: 0.40,          // ×w 管速 px/s（原版 ≈0.44w/s；0.40 给换缝窗口留余量）
  GRAVITY: 2.40,        // ×h /s²
  FLAP_VY: -0.65,       // ×h /s（跳高≈缝高49%，原版≈45~50%；契约值 -0.72 跳高58%偏弹）
  MAX_FALL: 1.35,       // ×h /s
  RESTART_DELAY: 500,   // over 后忽略点击的 ms
};

// 调色板（与 CONTRACT.md 色值表逐项一致；明暗同值项两组重复给出）。
// star 在 light 主题不画，契约约定给 null。
const COLORS_LIGHT = {
  skyTop: '#7ED3DE',
  skyBottom: '#C9ECF2',
  star: null,
  cloud: 'rgba(255,255,255,.9)',

  pipeBody: '#58B94C',
  pipeEdge: '#3E9437',
  pipeLip: '#6BC85E',
  pipeHi: 'rgba(255,255,255,.35)',

  birdBody: '#FFD93B',
  birdEdge: '#B8860B',
  birdBelly: '#FFF3C4',
  birdWing: '#F5A623',
  birdBeak: '#F5A623',

  grass: '#7FD35F',
  grassEdge: '#5CB542',
  sand: '#E7DFA4',
  sandLine: '#CFC387',

  hudText: '#FFFFFF',
  hudStroke: '#2B6B72',

  badgeBg: 'rgba(255,255,255,.85)',
  badgeText: '#2B6B72',

  hintBg: 'rgba(255,255,255,.75)',
  hintText: '#2B6B72',

  mask: 'rgba(20,40,45,.35)',
  panelBg: '#FFF8E7',
  panelEdge: '#D9C48A',
  panelText: '#5B4A21',

  btnBg: '#F5A623',
  btnEdge: '#D18A0F',
  btnText: '#FFFFFF',

  medalGold: '#E0A62B',
  medalGoldEdge: '#8C5E14',
  medalSilver: '#C0C4CE',
  medalSilverEdge: '#8A8F9C',
  medalBronze: '#D08A5A',
  medalBronzeEdge: '#8F5B32',
};

const COLORS_DARK = {
  skyTop: '#101A33',
  skyBottom: '#1F2C52',
  star: '#FFFFFF',
  cloud: 'rgba(255,255,255,.25)',

  pipeBody: '#2F6B3F',
  pipeEdge: '#1F4A2C',
  pipeLip: '#3D7F4F',
  pipeHi: 'rgba(255,255,255,.2)',

  birdBody: '#FFD93B',
  birdEdge: '#B8860B',
  birdBelly: '#FFF3C4',
  birdWing: '#F5A623',
  birdBeak: '#F5A623',

  grass: '#4C7A4F',
  grassEdge: '#3A5F3D',
  sand: '#3A3427',
  sandLine: '#554C36',

  hudText: '#FFFFFF',
  hudStroke: '#2B6B72',

  badgeBg: 'rgba(255,255,255,.14)',
  badgeText: '#C9D6F5',

  hintBg: 'rgba(255,255,255,.14)',
  hintText: '#C9D6F5',

  mask: 'rgba(20,40,45,.35)',
  panelBg: '#FFF8E7',
  panelEdge: '#D9C48A',
  panelText: '#5B4A21',

  btnBg: '#F5A623',
  btnEdge: '#D18A0F',
  btnText: '#FFFFFF',

  medalGold: '#E0A62B',
  medalGoldEdge: '#8C5E14',
  medalSilver: '#C0C4CE',
  medalSilverEdge: '#8A8F9C',
  medalBronze: '#D08A5A',
  medalBronzeEdge: '#8F5B32',
};

// 奖牌门槛
const MEDAL = {
  GOLD_AT: 60,
  SILVER_AT: 30,
  BRONZE_AT: 10,
};

module.exports = { PHYS, COLORS_LIGHT, COLORS_DARK, MEDAL };
