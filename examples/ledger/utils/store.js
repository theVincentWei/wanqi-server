// 存储封装:storage 优先,内存兜底(同一次会话内始终可用)。
const KEY = 'ledger_txs_v1'
let memory = null

function pad(n) { return n < 10 ? '0' + n : '' + n }

function decorate(item) {
  const d = new Date(item.ts)
  return Object.assign({}, item, {
    amountText: item.amount.toFixed(2),
    dateText: `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  })
}

function load() {
  if (memory) return memory
  try {
    const saved = wx.getStorageSync(KEY)
    if (Array.isArray(saved)) { memory = saved; return memory }
  } catch (e) { /* fallthrough */ }
  memory = []
  return memory
}

function save(list) {
  memory = list
  try { wx.setStorageSync(KEY, list) } catch (e) { /* 忽略:仅本次会话有效 */ }
}

function all() { return load().slice().sort((a, b) => b.ts - a.ts).map(decorate) }

function add(entry) {
  const list = load()
  list.push(entry)
  save(list)
}

function summary(list) {
  let income = 0
  let expense = 0
  for (const item of list) {
    if (item.type === 'income') income += item.amount
    else expense += item.amount
  }
  return { income, expense, balance: income - expense }
}

module.exports = { all, add, summary }
