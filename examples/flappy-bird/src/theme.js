// 主题:light/dark 双 palette。字段名契约固定,色值按契约调色板表。
// 用法:const pal = theme.init(next => { pal = next });之后每帧读 theme.getPalette()。
const LIGHT = {
  // 天空
  skyTop: '#7ED3DE',
  skyBottom: '#C9ECF2',
  star: null, // light 不画星星
  cloud: 'rgba(255,255,255,.9)',
  // 管道
  pipeBody: '#58B94C',
  pipeEdge: '#3E9437',
  pipeLip: '#6BC85E',
  pipeHi: 'rgba(255,255,255,.35)',
  // 鸟(明暗同值)
  birdBody: '#FFD93B',
  birdEdge: '#B8860B',
  birdBelly: '#FFF3C4',
  birdWing: '#F5A623',
  birdBeak: '#F5A623',
  // 地面
  grass: '#7FD35F',
  grassEdge: '#5CB542',
  sand: '#E7DFA4',
  sandLine: '#CFC387',
  // 大分数/标题(白字描边,明暗同值)
  hudText: '#FFFFFF',
  hudStroke: '#2B6B72',
  // 最高分徽章
  badgeBg: 'rgba(255,255,255,.85)',
  badgeText: '#2B6B72',
  // 起飞提示胶囊
  hintBg: 'rgba(255,255,255,.75)',
  hintText: '#2B6B72',
  // over 面板(明暗同值)
  mask: 'rgba(20,40,45,.35)',
  panelBg: '#FFF8E7',
  panelEdge: '#D9C48A',
  panelText: '#5B4A21',
  btnBg: '#F5A623',
  btnEdge: '#D18A0F',
  btnText: '#FFFFFF',
  // 奖牌(明暗同值)
  medalGold: '#E0A62B',
  medalGoldEdge: '#8C5E14',
  medalSilver: '#C0C4CE',
  medalSilverEdge: '#8A8F9C',
  medalBronze: '#D08A5A',
  medalBronzeEdge: '#8F5B32',
}

const DARK = {
  // 天空
  skyTop: '#101A33',
  skyBottom: '#1F2C52',
  star: '#FFFFFF',
  cloud: 'rgba(255,255,255,.25)',
  // 管道
  pipeBody: '#2F6B3F',
  pipeEdge: '#1F4A2C',
  pipeLip: '#3D7F4F',
  pipeHi: 'rgba(255,255,255,.2)',
  // 鸟(明暗同值)
  birdBody: '#FFD93B',
  birdEdge: '#B8860B',
  birdBelly: '#FFF3C4',
  birdWing: '#F5A623',
  birdBeak: '#F5A623',
  // 地面
  grass: '#4C7A4F',
  grassEdge: '#3A5F3D',
  sand: '#3A3427',
  sandLine: '#554C36',
  // 大分数/标题(白字描边,明暗同值)
  hudText: '#FFFFFF',
  hudStroke: '#2B6B72',
  // 最高分徽章
  badgeBg: 'rgba(255,255,255,.14)',
  badgeText: '#C9D6F5',
  // 起飞提示胶囊
  hintBg: 'rgba(255,255,255,.14)',
  hintText: '#C9D6F5',
  // over 面板(明暗同值)
  mask: 'rgba(20,40,45,.35)',
  panelBg: '#FFF8E7',
  panelEdge: '#D9C48A',
  panelText: '#5B4A21',
  btnBg: '#F5A623',
  btnEdge: '#D18A0F',
  btnText: '#FFFFFF',
  // 奖牌(明暗同值)
  medalGold: '#E0A62B',
  medalGoldEdge: '#8C5E14',
  medalSilver: '#C0C4CE',
  medalSilverEdge: '#8A8F9C',
  medalBronze: '#D08A5A',
  medalBronzeEdge: '#8F5B32',
}

let current = LIGHT

function getPalette() {
  return current
}

// 读系统主题,缺 API/缺 theme 字段 → light
function detectTheme() {
  try {
    const sys = wx.getSystemInfoSync()
    if (sys && sys.theme === 'dark') return 'dark'
  } catch (e) {
    /* fallthrough */
  }
  return 'light'
}

// 挂初值 + 热切换监听。返回初始 pal;onChange(pal) 在系统切主题时被调(下一帧自动重绘)。
function init(onChange) {
  current = detectTheme() === 'dark' ? DARK : LIGHT
  try {
    wx.onThemeChange((res) => {
      const next = res && res.theme === 'dark' ? DARK : LIGHT
      if (next === current) return
      current = next
      if (typeof onChange === 'function') {
        try {
          onChange(current)
        } catch (e) {
          /* 回调异常不影响主题切换 */
        }
      }
    })
  } catch (e) {
    /* 容器不支持主题监听 → 保持初始主题 */
  }
  return current
}

module.exports = { init, getPalette }
