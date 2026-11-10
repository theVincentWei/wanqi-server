/**
 * 事件面板公共工具：统一格式化音频事件日志，最多保留 60 条。
 */
function now() {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + ('00' + d.getMilliseconds()).slice(-3)
}

function formatPayload(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const parts = []
  for (const key of Object.keys(payload)) {
    const value = payload[key]
    parts.push(key + '=' + (typeof value === 'number' ? Math.round(value * 1000) / 1000 : JSON.stringify(value)))
  }
  return parts.join(' ')
}

/**
 * 追加一条事件日志到页面 logs（最新在上），kind: '' 普通事件 / 'error' 错误 / 'info' 操作回显。
 */
function pushLog(page, text, kind) {
  const logs = [{ text: now() + ' ' + text, kind: kind || '' }].concat(page.data.logs)
  page.setData({ logs: logs.slice(0, 60) })
}

function pushEvent(page, name, payload, kind) {
  pushLog(page, '[事件] ' + name + (formatPayload(payload) ? '  ' + formatPayload(payload) : ''), kind)
}

module.exports = {
  pushLog,
  pushEvent,
}
