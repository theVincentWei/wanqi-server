// 标准汉语拼音声韵拆分：py0(无调音节串) -> { ini, fin } | null。
// 契约 §5.2 要点：
//   - 零声母 ini=''（ai/ou/er/a...）；
//   - ü 兼收 v 写法（lv/nv）与 ü 本字；
//   - y/w 按声母位处理：y+u 形韵母归 ü 族（yun→y+ün、yue→y+üe、yu→y+ü、yuan→y+üan），
//     w 直接去 w 得韵母（wa→w+a、wei→w+ei）；
//   - 契约定案 qu→q+ü、xu→x+u：q/y 后 u 形一律视作 ü（普通话里 q/y 不拼真 u，恒成立）；
//     j/x 后保留源数据写法（pinyin-pro 对 ju/ju/xu 类写法不统一，引擎照单全收，
//     两种写法在 flypy 键位上等价，由 flypy.check 做别名兼容，见 flypy.js）。
// 韵母不在已知表内时返回 null（seqOf 判 null；gen-charbank 据此剔除无法出键的音节）。

// 可作声母位的单字母（r 只出现在 r+韵母，与 er 无冲突；y/w 见上）
const SINGLE_INITIALS = 'bpmfdtnlgkhjqxrzcsyw';
const DIGRAPH_INITIALS = ['zh', 'ch', 'sh'];

// 全部可出键的韵母（与 flypy.js 的韵母键表一一对应）
const VALID_FINALS = new Set([
  'a', 'o', 'e', 'er', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'ong',
  'i', 'ia', 'ie', 'iao', 'iu', 'ian', 'in', 'iang', 'ing', 'iong',
  'u', 'ua', 'uo', 'uai', 'ui', 'uan', 'un', 'uang', 'ueng',
  'ü', 'üe', 'üan', 'ün',
]);

function splitSyllable(py0) {
  const s = String(py0 == null ? '' : py0).toLowerCase().replace(/[^a-züv]/g, '');
  if (!s) return null;

  let ini = '';
  let fin = s;

  // 双字母声母优先（zh/ch/sh）
  const two = s.slice(0, 2);
  if (DIGRAPH_INITIALS.indexOf(two) >= 0) {
    ini = two;
    fin = s.slice(2);
  } else if (SINGLE_INITIALS.indexOf(s[0]) >= 0) {
    ini = s[0];
    fin = s.slice(1);
  }

  // v 一律视作 ü
  fin = fin.replace(/v/g, 'ü');

  // j/q/x/y 后的 u 形韵母在语音上恒为 ü：
  //   多字母形 ue/uan/un → üe/üan/ün（军=jun→j+ün）
  //   单韵母 u：q/y 后归 ü（契约 qu→q+ü、yu→y+ü）；j/x 后保留源写法
  //   （契约 xu→x+u，pinyin-pro 对 ju/xu 类写法不统一，引擎照单全收，
  //   两种写法键位等价，由 flypy.check 做别名兼容）
  if ((ini === 'j' || ini === 'q' || ini === 'x' || ini === 'y') && fin.charAt(0) === 'u') {
    if (fin === 'ue') fin = 'üe';
    else if (fin === 'uan') fin = 'üan';
    else if (fin === 'un') fin = 'ün';
    else if (fin === 'u' && (ini === 'q' || ini === 'y')) fin = 'ü';
  }

  if (!fin || !VALID_FINALS.has(fin)) return null;
  return { ini: ini, fin: fin };
}

module.exports = { splitSyllable, VALID_FINALS };
