// 深浅色主题（照 sys-monitor v6 范式）：容器仅对 app.json 声明 "darkmode": true 的包
// 下发 theme 并触发 wx.onThemeChange。注意 wxss 的 @media(prefers-color-scheme) 在
// 容器 WebView 里恒报 light（宿主 targetSdk<33），内容层深色必须 JS 驱动：
// 页面根节点挂 .dark class（app.wxss 变量组整体翻转）+ canvas/图形件用本文件调色板。
const CANVAS = {
  light: {
    track: '#E3E9F0',
    gridText: '#8B98A8',
    line1: '#2F6FD6',
    line2: '#C9803C',
  },
  dark: {
    track: '#232D3A',
    gridText: '#748699',
    line1: '#4D9DFF',
    line2: '#FF9D4D',
  },
}

function normalize(theme) {
  return theme === 'dark' ? 'dark' : 'light'
}

// 当前主题；未声明 darkmode / API 异常时按浅色（微信语义：未适配=永远浅色）
function current() {
  try {
    return normalize(wx.getSystemInfoSync().theme)
  } catch (e) {
    return 'light'
  }
}

// canvas 用调色板（正确率蓝 line1 / 速度橙 line2，只换轨道/网格这类中性色）
function palette(theme) {
  return CANVAS[normalize(theme)]
}

// 页面接入：onLoad 里 `this.detachTheme = theme.attach(this)`，onUnload 里
// `this.detachTheme && this.detachTheme()`。页面需实现 applyTheme(theme)：
// setData({ theme }) 挂根节点 class，并重画依赖主题色的 canvas。
function attach(page) {
  page.applyTheme(current())
  const handler = (res) => page.applyTheme(normalize(res && res.theme))
  wx.onThemeChange(handler)
  return function detach() {
    wx.offThemeChange(handler)
  }
}

module.exports = { current, palette, attach }
