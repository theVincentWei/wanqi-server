// 系统监视器公共格式化(与原版 baigong miniapps/sys-monitor h5 同口径)。
// 数据源:本机 sys-monitor daemon(9207),小程序经 AppHub 网关访问
// (miniprogram-spec §7:网关是后端唯一对外口;固定 127.0.0.1:7610,
// 仿真器走 adb reverse tcp:7610,真机走 SSH 链路的固定 7610 转发),
// 小程序免配置直连,不再提供地址设置(2026-11-09 v2 定档,v5 改走网关)。
const BASE = 'http://127.0.0.1:7610/api/v1/apps/wx8d31a5f0c94b27e6'

// bytes → GB 形(7.3 GB / 0.19 GB / 360 GB);≥10 一位小数、<10 两位、≥100 取整
function fmtGB(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes)) return '—'
  const v = bytes / (1024 * 1024 * 1024)
  if (v >= 100) return Math.round(v) + ' GB'
  if (v >= 10) return v.toFixed(1) + ' GB'
  return v.toFixed(2) + ' GB'
}

// bytes → 人话(摘要涨幅:+2 GB / -512 MB)
function fmtDelta(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes === 0) return '0 GB'
  const sign = bytes > 0 ? '+' : '−'
  const abs = Math.abs(bytes)
  const gb = abs / (1024 * 1024 * 1024)
  if (gb >= 1) return sign + (gb >= 10 ? Math.round(gb) : gb.toFixed(1)) + ' GB'
  return sign + Math.round(abs / (1024 * 1024)) + ' MB'
}

// 秒 → 「11 天 7 小时」/「3 小时 12 分」/「45 分钟」
function fmtUptime(sec) {
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '—'
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const mins = Math.floor((sec % 3600) / 60)
  if (days > 0) return days + ' 天 ' + hours + ' 小时'
  if (hours > 0) return hours + ' 小时 ' + mins + ' 分'
  return mins + ' 分钟'
}

function fmtPct(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—'
  return Math.round(v) + '%'
}

function fmtNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—'
  return v.toFixed(2)
}

// 进程内存短形(1.0 GB / 512 MB)
function fmtMemShort(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '—'
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return (gb >= 10 ? Math.round(gb) : gb.toFixed(1)) + ' GB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

function hhmm(ts) {
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

module.exports = { BASE, fmtGB, fmtDelta, fmtUptime, fmtPct, fmtNum, fmtMemShort, hhmm }
