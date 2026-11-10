// sp-core 冒烟测试：node tools/smoke.js 直跑（无 wx 依赖）。
// 覆盖 SPEC §7 sp-core 验收：§5.2 全部拆分用例、§5.3 全部键位用例、
// check/别名、charbank（字量≥1200 + schema + keys/ini/fin 全量自洽）、
// store（recordSession/getSessions/getSession/getFinalStats/getOverview/
// input 透传/500 上限/storage 兜底/cfg 往返）。
const path = require('path');
const syllable = require('../utils/syllable');
const flypy = require('../utils/flypy');
const store = require('../utils/store');

const { splitSyllable } = syllable;
const { INITIALS_KEY, FINALS_KEY, ZERO_INITIAL, KEY_LABELS, keysOf, seqOf, check } = flypy;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label + (detail ? '  -> ' + detail : ''));
    console.log('FAIL', label, detail || '');
  }
}

function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  ok(good, label, good ? '' : 'expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
}

// ---------------- §5.2 splitSyllable 全部契约用例 ----------------
const SPLIT_CASES = [
  ['zhong', 'zh', 'ong'], ['shuang', 'sh', 'uang'], ['guo', 'g', 'uo'],
  ['jia', 'j', 'ia'], ['xing', 'x', 'ing'], ['kuai', 'k', 'uai'],
  ['lv', 'l', 'ü'], ['nv', 'n', 'ü'], ['qu', 'q', 'ü'],
  ['yue', 'y', 'üe'], ['yun', 'y', 'ün'], ['xu', 'x', 'u'],
  ['tian', 't', 'ian'], ['min', 'm', 'in'], ['ming', 'm', 'ing'],
  ['niang', 'n', 'iang'], ['ai', '', 'ai'], ['ou', '', 'ou'],
  ['er', '', 'er'], ['a', '', 'a'],
];
SPLIT_CASES.forEach(([py0, ini, fin]) => {
  eq(splitSyllable(py0), { ini: ini, fin: fin }, '§5.2 splitSyllable(' + py0 + ')');
});

// 拆分引擎补充自检（非契约必过，防回归）
const SPLIT_EXTRA = [
  ['bang', 'b', 'ang'], ['shu', 'sh', 'u'], ['zhi', 'zh', 'i'], ['ri', 'r', 'i'],
  ['wu', 'w', 'u'], ['wa', 'w', 'a'], ['wei', 'w', 'ei'], ['wang', 'w', 'ang'],
  ['yi', 'y', 'i'], ['ying', 'y', 'ing'], ['yong', 'y', 'ong'], ['yo', 'y', 'o'],
  ['yuan', 'y', 'üan'], ['yu', 'y', 'ü'], ['jun', 'j', 'ün'], ['jue', 'j', 'üe'],
  ['juan', 'j', 'üan'], ['xun', 'x', 'ün'], ['xuan', 'x', 'üan'], ['xue', 'x', 'üe'],
  ['qun', 'q', 'ün'], ['quan', 'q', 'üan'], ['que', 'q', 'üe'], ['ju', 'j', 'u'],
  ['lü', 'l', 'ü'], ['nü', 'n', 'ü'], ['e', '', 'e'], ['o', '', 'o'], ['en', '', 'en'],
];
SPLIT_EXTRA.forEach(([py0, ini, fin]) => {
  eq(splitSyllable(py0), { ini: ini, fin: fin }, 'splitSyllable extra(' + py0 + ')');
});
ok(splitSyllable('ng') === null, 'splitSyllable(ng) 应为 null');
ok(splitSyllable('') === null, 'splitSyllable("") 应为 null');
ok(splitSyllable('xyzq') === null, 'splitSyllable(未知韵母) 应为 null');

// ---------------- §5.3 flypy 全部契约用例 ----------------
const KEY_CASES = [
  ['zhong', 'vs'], ['shuang', 'ul'], ['guo', 'go'], ['jia', 'jx'], ['xing', 'xk'],
  ['kuai', 'kk'], ['lv', 'lv'], ['nv', 'nv'], ['qu', 'qv'], ['yue', 'yt'],
  ['yun', 'yy'], ['tian', 'tm'], ['mian', 'mm'], ['min', 'mb'], ['ming', 'mk'],
  ['niang', 'nl'], ['ai', 'ad'], ['ou', 'oz'], ['er', 'er'], ['xu', 'xu'],
];
KEY_CASES.forEach(([py0, keys]) => {
  eq(seqOf(py0), keys, '§5.3 seqOf(' + py0 + ')');
  const sp = splitSyllable(py0);
  eq(keysOf(sp.ini, sp.fin), keys, '§5.3 keysOf(' + sp.ini + ',' + sp.fin + ')');
});

// 键位引擎补充自检（Rime flypy 行为对齐，非契约必过）
const KEY_EXTRA = [
  ['yuan', 'yr'], ['quan', 'qr'], ['xue', 'xt'], ['jun', 'jy'], ['hui', 'hv'],
  ['shi', 'ui'], ['shu', 'uu'], ['wai', 'wd'], ['wei', 'ww'], ['yong', 'ys'],
  ['wu', 'wu'], ['yi', 'yi'], ['zang', 'zh'], ['sang', 'sh'], ['cheng', 'ig'],
];
KEY_EXTRA.forEach(([py0, keys]) => {
  eq(seqOf(py0), keys, 'seqOf extra(' + py0 + ')');
});

// check()：严格键序 + jqx/y 后 ü/u 别名（flypy 定案：打 u 或 v 均可）
eq(check('ul', 'shuang'), { ok: true, expected: 'ul' }, "check('ul','shuang')");
eq(check('uv', 'shuang'), { ok: false, expected: 'ul' }, "check('uv','shuang') 不通过");
eq(check('qv', 'qu'), { ok: true, expected: 'qv' }, "check('qv','qu') 严格通过");
eq(check('qu', 'qu'), { ok: true, expected: 'qv' }, "check('qu','qu') 别名兼容");
eq(check('xv', 'xu'), { ok: true, expected: 'xu' }, "check('xv','xu') 别名兼容");
eq(check('xu', 'xu'), { ok: true, expected: 'xu' }, "check('xu','xu') 严格通过");
eq(check('yu', 'yu'), { ok: true, expected: 'yv' }, "check('yu','yu') 别名兼容");
eq(check('jv', 'ju'), { ok: true, expected: 'ju' }, "check('jv','ju') 别名兼容");
eq(check('go', 'guo'), { ok: true, expected: 'go' }, "check('go','guo')");
ok(check('v', 'shuang').ok === false && check('v', 'shuang').expected === 'ul', '半截键不通过且带 expected');
ok(check('', 'guo').ok === false, '空输入不通过');
ok(check('go', 'zzz') !== undefined && check('go', 'zzz').expected === null, '未知音节 expected=null');

// 键位表结构：26 键齐全、标注 = 韵母在前 + 翘舌声母在后
ok(Object.keys(KEY_LABELS).length === 26, 'KEY_LABELS 覆盖 26 键', JSON.stringify(Object.keys(KEY_LABELS)));
eq(KEY_LABELS.u, ['u', 'sh'], "KEY_LABELS.u");
eq(KEY_LABELS.i, ['i', 'ch'], "KEY_LABELS.i");
eq(KEY_LABELS.v, ['ui', 'ü', 'zh'], "KEY_LABELS.v");
eq(KEY_LABELS.l, ['iang', 'uang'], "KEY_LABELS.l");
eq(INITIALS_KEY, { zh: 'v', ch: 'i', sh: 'u' }, 'INITIALS_KEY');
eq(ZERO_INITIAL, { a: 'aa', e: 'ee', o: 'oo' }, 'ZERO_INITIAL');
Object.keys(FINALS_KEY).forEach((k) => {
  FINALS_KEY[k].forEach((fin) => {
    ok(keysOf('', fin) !== null || keysOf('b', fin) !== null, '韵母 ' + fin + ' 可出键');
  });
});

// ---------------- charbank（§5.1） ----------------
const bank = require('../data/charbank.json');
ok(bank && bank.v === 1, 'charbank.v === 1');
ok(Array.isArray(bank.chars), 'charbank.chars 是数组');
const chars = bank.chars;
ok(chars.length >= 1200, 'charbank 字量 ≥1200', 'actual=' + chars.length);
console.log('[charbank] 字量 =', chars.length);

const FIELDS = ['char', 'py', 'py0', 'ini', 'fin', 'keys', 'multi', 'ex', 'freq'];
let schemaBad = 0;
chars.forEach((e) => {
  if (FIELDS.some((f) => !(f in e))) schemaBad += 1;
  if (typeof e.char !== 'string' || e.char.length !== 1) schemaBad += 1;
  if (!/^[a-zü]+$/.test(e.py0)) schemaBad += 1;
  if (!/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/.test(e.py)) schemaBad += 1;
  if (typeof e.keys !== 'string' || !/^[a-z]{2}$/.test(e.keys)) schemaBad += 1;
  if (typeof e.multi !== 'boolean') schemaBad += 1;
  if (e.multi && typeof e.ex !== 'string') schemaBad += 1;
  if (!Number.isInteger(e.freq)) schemaBad += 1;
});
ok(schemaBad === 0, 'charbank schema 字段/类型全检', 'bad=' + schemaBad);

// freq = 表内排名：恰为 1..N 无重无漏
const freqs = chars.map((e) => e.freq).slice().sort((a, b) => a - b);
ok(freqs.every((f, i) => f === i + 1), 'freq 恰为 1..' + chars.length + ' 无重无漏');
ok(new Set(chars.map((e) => e.char)).size === chars.length, 'char 无重复');

// keys/ini/fin 与引擎全量自洽（比契约要求的抽查 100 字更严）
let selfConsistent = 0;
const inconsistent = [];
chars.forEach((e) => {
  const sp = splitSyllable(e.py0);
  const k = seqOf(e.py0);
  if (sp && sp.ini === e.ini && sp.fin === e.fin && k === e.keys) selfConsistent += 1;
  else if (inconsistent.length < 5) inconsistent.push(e.char);
});
ok(selfConsistent === chars.length, '全量 ' + chars.length + ' 字 keys/ini/fin 与引擎自洽',
  'inconsistent=' + JSON.stringify(inconsistent));

// 随机抽 100 字的统计断言（契约 §7 明文要求的抽查形态）
const rnd = [];
const used = new Set();
while (rnd.length < 100 && rnd.length < chars.length) {
  const i = Math.floor(Math.random() * chars.length);
  if (used.has(i)) continue;
  used.add(i);
  rnd.push(chars[i]);
}
let rndBad = 0;
rnd.forEach((e) => {
  const sp = splitSyllable(e.py0);
  if (!sp || flypy.keysOf(sp.ini, sp.fin) !== e.keys) rndBad += 1;
});
ok(rndBad === 0, '随机抽查 100 字 keys 自洽', 'bad=' + rndBad);

// 多音字必带例词；单音字 ex 可 null
const multiNoEx = chars.filter((e) => e.multi && !e.ex);
ok(multiNoEx.length === 0, 'multi=true 均带 ex', JSON.stringify(multiNoEx.slice(0, 5)));
const multiCount = chars.filter((e) => e.multi).length;
console.log('[charbank] multi=true =', multiCount);

// ---------------- store（§5.4） ----------------
// 默认 node 环境即内存后端；清态起步
store._useStorage(null);
store._reset();

// 锚定「今天本地 12:00」，保证天数聚合/连续天断言与运行时刻无关
const now = new Date();
const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
const mk = (over) => Object.assign({ mode: 'look', finals: [], count: 0, correct: 0, durationMs: 0, per: [] }, over);

const s1 = mk({
  finals: ['a', 'ang'], count: 3, correct: 2, durationMs: 6000, input: 'builtin', ts: t0,
  per: [
    { char: '双', py0: 'shuang', keys: 'ul', typed: 'ul', ok: true, ms: 800 },
    { char: '帮', py0: 'bang', keys: 'bh', typed: 'bh', ok: true, ms: 700 },
    { char: '爱', py0: 'ai', keys: 'ad', typed: 'da', ok: false, ms: 900 },
  ],
});
const s2 = mk({
  finals: ['uang'], count: 2, correct: 1, durationMs: 4000, input: 'system', ts: t0 + 60000,
  per: [
    { char: '光', py0: 'guang', keys: 'gh', typed: 'gh', ok: true, ms: 600 },
    { char: '床', py0: 'chuang', keys: 'ih', typed: 'ih', ok: false, ms: 800 },
  ],
});
const r1 = store.recordSession(s1);
const r2 = store.recordSession(s2);
ok(r1 && r1.id && r2 && r2.id && r1.id !== r2.id, 'recordSession 返回 {id} 且唯一');

// getSessions：ts 降序
const list = store.getSessions(10);
ok(list.length === 2, 'getSessions(10) 条数=2', 'actual=' + list.length);
ok(list[0].id === r2.id && list[1].id === r1.id, 'getSessions 按 ts 降序');
ok(list[0].input === 'system' && list[1].input === 'builtin', 'input 字段原样透传（Lead 补充契约）');

// getSession
const got = store.getSession(r1.id);
ok(got && got.id === r1.id && got.count === 3 && got.correct === 2, 'getSession(id) 取回原记录');
ok(got.per.length === 3 && got.per[0].char === '双', 'getSession(id).per 原样');
ok(store.getSession('nope') === null, 'getSession(未知id) → null');

// getFinalStats：韵母聚合 + acc 升序（薄弱在前）
// 双(uang,对) 帮(ang,对) 爱(ai,错) 光(uang,对) 床(uang,错)
// → ai 0/1=0、uang 2/3=67、ang 1/1=100，按 acc 升序
const stats = store.getFinalStats();
eq(stats, [
  { fin: 'ai', shown: 1, correct: 0, acc: 0 },
  { fin: 'uang', shown: 3, correct: 2, acc: 67 },
  { fin: 'ang', shown: 1, correct: 1, acc: 100 },
], 'getFinalStats() 聚合与 acc 升序');

// getOverview
const ov = store.getOverview();
ok(ov.totalChars === 5, 'getOverview.totalChars=5(题数累计)', 'actual=' + ov.totalChars);
ok(ov.totalGroups === 2, 'getOverview.totalGroups=2', 'actual=' + ov.totalGroups);
ok(ov.streakDays >= 1, 'getOverview.streakDays≥1', 'actual=' + ov.streakDays);
ok(Array.isArray(ov.days) && ov.days.length === 14, 'getOverview.days 长 14');
ok(/^\d{2}-\d{2}$/.test(ov.days[13].date), 'days[].date 格式 MM-DD', ov.days[13].date);
ok(ov.days[13].acc === 60, '今天 acc=round(3/5*100)=60', 'actual=' + ov.days[13].acc);
ok(ov.days[13].avgSec === 2, '今天 avgSec=10000ms/5=2s', 'actual=' + ov.days[13].avgSec);
ok(ov.days[0].acc === 0 && ov.days[0].avgSec === 0, '无练习日 acc/avgSec=0');

// 500 条上限：丢最旧、留最新
for (let i = 0; i < 510; i++) {
  store.recordSession(mk({ ts: t0 + 100000 + i, count: 1, correct: 1, durationMs: 1000, per: [] }));
}
const capped = store.getSessions();
ok(capped.length === 500, 'sessions 上限 500', 'actual=' + capped.length);
ok(capped[0].ts === t0 + 100000 + 509, '超限保留最新一条');

// storage 兜底：后端抛错时仅内存仍可用（ledger 范式）
const thrower = { get: () => { throw new Error('boom'); }, set: () => { throw new Error('boom'); } };
store._useStorage(thrower);
store._reset();
const r3 = store.recordSession(mk({ ts: t0 + 200000, count: 1, correct: 1, durationMs: 1000, per: [{ char: '爱', py0: 'ai', keys: 'ad', typed: 'ad', ok: true, ms: 100 }] }));
ok(r3 && r3.id && store.getSessions(1).length === 1, 'storage 全抛错时内存兜底可用');
store.getFinalStats(); // 不抛错即可
ok(true, '兜底模式下 getFinalStats 不抛错');

// cfg：默认值 + 往返
store._useStorage(null);
store._reset();
const dcfg = store.loadCfg();
eq(dcfg, { finals: [], mode: 'look', input: 'builtin', hint: false, count: 20 }, 'loadCfg 默认值');
store.saveCfg({ hint: true, count: 30, finals: ['a', 'ang'] });
const scfg = store.loadCfg();
ok(scfg.hint === true && scfg.count === 30 && scfg.input === 'builtin' && scfg.mode === 'look', 'saveCfg 覆盖保存');
eq(scfg.finals, ['a', 'ang'], 'cfg.finals 数组保存');
eq(Object.keys(store.KEY), ['cfg', 'sessions', 'finals'], 'KEY 常量契约');

// ---------------- 汇总 ----------------
console.log('---------------------------------------------');
console.log('PASS', pass, 'FAIL', fail);
if (fail > 0) {
  console.log('FAILED:');
  failures.forEach((f) => console.log('  -', f));
  process.exit(1);
}
console.log('ALL GREEN');
