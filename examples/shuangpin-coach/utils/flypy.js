// 小鹤双拼键位引擎。映射内嵌自定案数据 <工作区>/shuangpin-coach/data/flypy.json
// （来源 Rime 官方 double_pinyin_flypy 码表），不运行时读文件。
// 键位速查：zh→v ch→i sh→u；ü→v üe→t ün→y；üan 与 uan 同在 r（jqx/y 后 ü 恒打 u 位，
// 故 üan 出键取 uan 位，元=yr、全=qr）；ing/uai 同 k，iang/uang 同 l，ong/iong 同 s。
const splitSyllable = require('./syllable').splitSyllable;

// 声母键（zh/ch/sh 三个翘舌归 v/i/u，其余声母键=字母本身）
const INITIALS_KEY = { zh: 'v', ch: 'i', sh: 'u' };

// 键 → 韵母（照 flypy.json finals 原样内嵌）
const FINALS_KEY = {
  q: ['iu'], w: ['ei'], e: ['e'], r: ['uan', 'er'], t: ['ue', 'üe'],
  y: ['un', 'ün'], u: ['u'], i: ['i'], o: ['o', 'uo'], p: ['ie'],
  a: ['a'], s: ['ong', 'iong'], d: ['ai'], f: ['en'], g: ['eng'], h: ['ang'],
  j: ['an'], k: ['ing', 'uai'], l: ['iang', 'uang'],
  z: ['ou'], x: ['ia', 'ua'], c: ['ao'], v: ['ui', 'ü'], b: ['in'],
  n: ['iao'], m: ['ian'],
};

// 单韵母 a/o/e 零声母双打首字母；其余零声母 = 首字母 + 韵母键（keysOf 内实现）
const ZERO_INITIAL = { a: 'aa', e: 'ee', o: 'oo' };

// 韵母 → 键。由 FINALS_KEY 反推，并补两条推导：üan 走 uan 的 r 位（元=yr）、
// ueng 走 eng 的 g 位（翁=weng=w+g）。er 直打 e+r（二=er）。
const FIN_KEY = (function build() {
  const m = {};
  Object.keys(FINALS_KEY).forEach(function (k) {
    FINALS_KEY[k].forEach(function (fin) { m[fin] = k; });
  });
  m['üan'] = 'r';
  m['ueng'] = 'g';
  return m;
})();

// 键盘小字标注：韵母在前，带声母的键把声母追加在后（u:['u','sh'] v:['ui','ü','zh']）
const KEY_LABELS = (function build() {
  const labels = {};
  Object.keys(FINALS_KEY).forEach(function (k) {
    labels[k] = FINALS_KEY[k].slice();
  });
  Object.keys(INITIALS_KEY).forEach(function (ini) {
    labels[INITIALS_KEY[ini]].push(ini);
  });
  return labels;
})();

function initialKey(ini) {
  if (!ini) return '';
  if (INITIALS_KEY[ini]) return INITIALS_KEY[ini];
  if (ini.length === 1) return ini;
  return null;
}

// keysOf(ini, fin) -> 两键小写串 | null
//   声韵齐全：声母键 + 韵母键（zhong→vs）
//   零声母：单韵母 a/o/e 双打（a→aa），其余首字母 + 韵母键（ai→ad、er→er）
function keysOf(ini, fin) {
  const ik = initialKey(ini);
  const fk = FIN_KEY[fin];
  if (ik === null || !fk) return null;
  if (!ini) {
    if (ZERO_INITIAL[fin]) return ZERO_INITIAL[fin];
    return fin.charAt(0) + fk;
  }
  return ik + fk;
}

// seqOf(py0) -> 'ul' 形式的两键串 | null（splitSyllable + keysOf 组合入口）
function seqOf(py0) {
  const sp = splitSyllable(py0);
  if (!sp) return null;
  return keysOf(sp.ini, sp.fin);
}

// check(inputKeys, py0) -> { ok, expected }
//   严格键序为 expected=seqOf(py0)；另兼容 jqx/y 声母后 ü/u 互打的别名
//   （flypy 定案：jqx 后的 ü 打 u 或 v 均可，如 去=qv 或 qu、徐=xu 或 xv）。
function check(inputKeys, py0) {
  const expected = seqOf(py0);
  const input = String(inputKeys == null ? '' : inputKeys).toLowerCase().trim();
  if (!expected) return { ok: false, expected: null };
  let ok = input === expected;
  if (!ok && expected.length === 2) {
    const sp = splitSyllable(py0);
    const jqxy = sp && (sp.ini === 'j' || sp.ini === 'q' || sp.ini === 'x' || sp.ini === 'y');
    if (jqxy && expected[1] === 'v' && input === expected[0] + 'u') ok = true;
    if (jqxy && expected[1] === 'u' && input === expected[0] + 'v') ok = true;
  }
  return { ok: ok, expected: expected };
}

module.exports = {
  INITIALS_KEY: INITIALS_KEY,
  FINALS_KEY: FINALS_KEY,
  ZERO_INITIAL: ZERO_INITIAL,
  KEY_LABELS: KEY_LABELS,
  keysOf: keysOf,
  seqOf: seqOf,
  check: check,
};
