// 本地存储层（契约 §5.4）。ledger 兜底范式：一切 storage 读写包 try/catch，
// 失败退回进程内内存（同一次会话内始终可用）；storage 后端可注入（node 测试用
// _useStorage/_reset，页面代码不需要碰）。
const splitSyllable = require('./syllable').splitSyllable;

const KEY = {
  cfg: 'sp_cfg_v1',
  sessions: 'sp_sessions_v1',
  finals: 'sp_finals_v1',
};
const MAX_SESSIONS = 500; // sessions 上限，超出丢最旧
const DEFAULT_CFG = { finals: [], mode: 'look', input: 'builtin', hint: false, count: 20 };

// ---- storage 后端 ----
// wx 环境：wx.*StorageSync（自身再包 try/catch）；node/异常环境：内存 map。
const memStore = {};
const wxBackend = {
  get(k) {
    let v;
    try { v = wx.getStorageSync(k); } catch (e) { v = undefined; }
    return v;
  },
  set(k, v) {
    try { wx.setStorageSync(k, v); } catch (e) { /* 仅本次会话有效 */ }
  },
};
const memBackend = {
  get(k) {
    try { return memStore[k]; } catch (e) { return undefined; }
  },
  set(k, v) {
    try { memStore[k] = v; } catch (e) { /* ignore */ }
  },
};

let backend = (typeof wx !== 'undefined' && wx && wx.getStorageSync) ? wxBackend : memBackend;

// 测试注入：node 直跑时换任意 { get, set } 后端（如恒抛错后端验证兜底）
function _useStorage(custom) {
  backend = custom || ((typeof wx !== 'undefined' && wx && wx.getStorageSync) ? wxBackend : memBackend);
  caches = {};
}

function _reset() {
  Object.keys(memStore).forEach(function (k) { delete memStore[k]; });
  caches = {};
}

// ---- 读写封装（内存缓存优先，读失败/类型不符走兜底）----
let caches = {};

function loadRaw(key, fallback) {
  if (caches[key] !== undefined) return caches[key];
  let v;
  try { v = backend.get(key); } catch (e) { v = undefined; }
  caches[key] = v === undefined || v === null || v === '' ? fallback : v;
  return caches[key];
}

function saveRaw(key, val) {
  caches[key] = val;
  try { backend.set(key, JSON.parse(JSON.stringify(val))); } catch (e) { /* 忽略：仅本次会话有效 */ }
}

function loadSessions() {
  const v = loadRaw(KEY.sessions, []);
  return Array.isArray(v) ? v : [];
}

function loadFinals() {
  const v = loadRaw(KEY.finals, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ---- 配置 ----
function loadCfg() {
  const v = loadRaw(KEY.cfg, null);
  const saved = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const cfg = Object.assign({}, DEFAULT_CFG);
  Object.keys(saved).forEach(function (k) { cfg[k] = saved[k]; });
  if (!Array.isArray(cfg.finals)) cfg.finals = [];
  return cfg;
}

function saveCfg(cfg) {
  const cur = loadCfg();
  const next = Object.assign({}, cur, cfg && typeof cfg === 'object' ? cfg : {});
  if (!Array.isArray(next.finals)) next.finals = [];
  saveRaw(KEY.cfg, next);
  return next;
}

// ---- 练习记录 ----
// s = { mode:'look', finals:['a','ang'], count, correct, durationMs,
//       input:'builtin'|'system'(可选,Lead 2026-11-10 补充契约:result「再来一组」
//             需还原输入方式,原样透传,缺省 'builtin'),
//       per:[{char,py0,keys,typed,ok,ms}], ts }
// 返回 { id }；同时按 per[].py0 聚合韵母 shown/correct 计数。
function recordSession(s) {
  const src = s && typeof s === 'object' ? s : {};
  const ts = Number(src.ts) || Date.now();
  const id = 'g' + ts.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const rec = {
    id: id,
    mode: src.mode || 'look',
    finals: Array.isArray(src.finals) ? src.finals.slice() : [],
    count: Number(src.count) || 0,
    correct: Number(src.correct) || 0,
    durationMs: Number(src.durationMs) || 0,
    input: src.input || 'builtin',
    per: Array.isArray(src.per) ? src.per.slice() : [],
    ts: ts,
  };

  const list = loadSessions();
  list.push(rec);
  list.sort(function (a, b) { return b.ts - a.ts; });
  if (list.length > MAX_SESSIONS) list.length = MAX_SESSIONS;
  saveRaw(KEY.sessions, list);

  // 韵母聚合：py0 → fin（拆不出韵母的题不计）
  const fm = loadFinals();
  rec.per.forEach(function (it) {
    const sp = it ? splitSyllable(it.py0) : null;
    if (!sp) return;
    const cur = fm[sp.fin] || { shown: 0, correct: 0 };
    cur.shown += 1;
    if (it.ok) cur.correct += 1;
    fm[sp.fin] = cur;
  });
  saveRaw(KEY.finals, fm);

  return { id: id };
}

function getSession(id) {
  if (!id) return null;
  const hit = loadSessions().filter(function (s) { return s.id === id; });
  return hit.length ? hit[0] : null;
}

// 按 ts 降序取前 n 条
function getSessions(n) {
  const num = Number(n);
  const list = loadSessions().slice().sort(function (a, b) { return b.ts - a.ts; });
  return num > 0 ? list.slice(0, num) : list;
}

// 韵母统计，acc 升序（薄弱在前）；并列时题量多在前、再按韵母名稳定排序
function getFinalStats() {
  const fm = loadFinals();
  const rows = Object.keys(fm).map(function (fin) {
    const it = fm[fin] || {};
    const shown = Number(it.shown) || 0;
    const correct = Number(it.correct) || 0;
    return {
      fin: fin,
      shown: shown,
      correct: correct,
      acc: shown ? Math.round((correct / shown) * 100) : 0,
    };
  });
  rows.sort(function (a, b) {
    if (a.acc !== b.acc) return a.acc - b.acc;
    if (a.shown !== b.shown) return b.shown - a.shown;
    return a.fin < b.fin ? -1 : 1;
  });
  return rows;
}

// 总览：三卡数字 + 最近 14 天按天聚合（含今天，旧→新）
function getOverview() {
  const sessions = loadSessions();
  const fm = loadFinals();

  let totalChars = 0;
  Object.keys(fm).forEach(function (fin) {
    totalChars += Number(fm[fin].shown) || 0;
  });

  // 连续天数：从今天往回数；今天没练则从昨天数（隔一天没练才断签）
  const daySet = {};
  sessions.forEach(function (s) { daySet[dayKey(s.ts)] = true; });
  const today = new Date();
  function shift(days) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    d.setDate(d.getDate() - days);
    return dayKey(d.getTime());
  }
  let streakDays = 0;
  let cursor = daySet[shift(0)] ? 0 : (daySet[shift(1)] ? 1 : -1);
  while (cursor >= 0 && daySet[shift(cursor)]) {
    streakDays += 1;
    cursor += 1;
  }

  // 14 天按天聚合
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const key = shift(i);
    let shown = 0;
    let correct = 0;
    let dur = 0;
    sessions.forEach(function (s) {
      if (dayKey(s.ts) !== key) return;
      const per = Array.isArray(s.per) ? s.per : [];
      if (per.length) {
        per.forEach(function (it) {
          if (!it) return;
          shown += 1;
          if (it.ok) correct += 1;
        });
        dur += Number(s.durationMs) || 0;
      } else if (Number(s.count) > 0) {
        shown += Number(s.count);
        correct += Number(s.correct) || 0;
        dur += Number(s.durationMs) || 0;
      }
    });
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    d.setDate(d.getDate() - i);
    days.push({
      date: pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
      acc: shown ? Math.round((correct / shown) * 100) : 0,
      avgSec: shown ? Math.round((dur / shown / 1000) * 10) / 10 : 0,
    });
  }

  return {
    totalChars: totalChars,
    totalGroups: sessions.length,
    streakDays: streakDays,
    days: days,
  };
}

module.exports = {
  KEY: KEY,
  loadCfg: loadCfg,
  saveCfg: saveCfg,
  recordSession: recordSession,
  getSession: getSession,
  getSessions: getSessions,
  getFinalStats: getFinalStats,
  getOverview: getOverview,
  // 测试钩子（node smoke 用；页面代码勿用）
  _useStorage: _useStorage,
  _reset: _reset,
};
