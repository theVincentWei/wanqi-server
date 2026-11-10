// 深浅色主题:容器仅对 app.json 声明 "darkmode": true 的包下发 theme 并触发
// wx.onThemeChange。注意 wxss 的 @media(prefers-color-scheme) 在容器 WebView 里
// 恒报 light(宿主 targetSdk<33,算法化适配 API 不可用),内容层深色必须 JS 驱动:
// 页面根节点挂 .dark class(app.wxss 变量组整体翻转)+ canvas 用本文件调色板。
const CANVAS = {
  light: { ringTrack: '#E5E7EB', gridText: '#9CA3AF' },
  dark: { ringTrack: '#2A2F3A', gridText: '#7C8593' },
}

function normalize(theme) {
  return theme === 'dark' ? 'dark' : 'light'
}

// 当前主题;未声明 darkmode / API 异常时按浅色(微信语义:未适配=永远浅色)
function current() {
  try {
    return normalize(wx.getSystemInfoSync().theme)
  } catch (e) {
    return 'light'
  }
}

// canvas 用调色板(定稿三色 CPU 蓝/内存橙/存储红明暗同值,只换轨道/网格这类中性色)
function palette(theme) {
  return CANVAS[normalize(theme)]
}

// 页面接入:onLoad 里 `this.detachTheme = theme.attach(this)`,onUnload 里
// `this.detachTheme && this.detachTheme()`。页面需实现 applyTheme(theme):
// setData({ theme }) 挂根节点 class,并重画依赖主题色的 canvas。
function attach(page) {
  page.applyTheme(current())
  const handler = (res) => page.applyTheme(normalize(res && res.theme))
  wx.onThemeChange(handler)
  return function detach() {
    wx.offThemeChange(handler)
  }
}

module.exports = { current, palette, attach }
