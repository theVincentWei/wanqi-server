'use strict';

/**
 * Flappy Bird · 音效壳(shell)
 *
 * wx.createInnerAudioContext 包装:容器缺 API / 初始化失败时整体静默降级(no-op),
 * 游戏逻辑零感知。5 个实例常驻,src 赋值即触发原生预加载(MediaPlayer);
 * play 前 stop 支持快速重触发(wing 连拍/连续得分),stop 后 play 原生自动重 prepare。
 * 音频文件在包内 sfx/*.wav(相对路径 → filesDir/jsapp/<appid>/main/sfx/)。
 */

const NAMES = ['wing', 'point', 'hit', 'die', 'swoosh'];
const SRCS = {};
NAMES.forEach(function (n) { SRCS[n] = 'sfx/' + n + '.wav'; });

let ready = false;
let apiPresent = false;
let errCount = 0;
let okCount = 0;
let playCount = 0;
let lastErr = '';
const pool = {};

function init() {
  if (ready) return true;
  try {
    if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') {
      apiPresent = false;
      console.log('[flappy] sfx: createInnerAudioContext unavailable, muted');
      return false;
    }
    apiPresent = true;
    for (let i = 0; i < NAMES.length; i++) {
      pool[NAMES[i]] = makeInstance(NAMES[i]);
    }
    ready = true;
  } catch (e) {
    console.log('[flappy] sfx init failed: ' + e);
    ready = false;
  }
  return ready;
}

/** 新建实例并接好诊断探针。MediaPlayer 一旦 stop/reset 过,后续 prepareAsync 会静默挂死
 *  (首次 prepare 正常)——所以每次播放都销毁旧实例、新实例直接播。 */
function makeInstance(name) {
  const a = wx.createInnerAudioContext();
  a.onError(function (res) {
    errCount++;
    try {
      lastErr = String((res && (res.errMsg || res.err)) || res || 'unknown').slice(0, 28);
    } catch (e2) { lastErr = '?'; }
    console.log('[flappy] sfx error #' + errCount + ': ' + lastErr);
  });
  a.onPlay(function () { okCount++; });
  a.src = SRCS[name];
  return a;
}

/** 诊断:临时用。'on e{错} ok{成} p{调}' = API 就绪;noapi=容器缺 createInnerAudioContext;err=初始化抛异常。 */
function diag() {
  if (ready) return 'on e' + errCount + ' ok' + okCount + ' p' + playCount;
  return apiPresent ? 'err' : 'noapi';
}

function lastError() { return lastErr; }

/** 单次播放失败不致命(文件缺失/解码失败只 error 事件),不整体降级。 */
function play(name) {
  init(); // 幂等;启动期 wire 可能丢失,首帧/首次播放时补建
  if (!ready) return;
  playCount++;
  try {
    const old = pool[name];
    if (old) {
      try { old.destroy(); } catch (e2) { /* 旧实例销毁失败不影响新实例 */ }
    }
    const a = makeInstance(name);
    pool[name] = a;
    a.play(); // 新实例 src 已设:play → waitUntilPrepared → onPrepared → 自动起播
  } catch (e) {
    errCount++;
    lastErr = String(e).slice(0, 28);
    console.log('[flappy] sfx play ' + name + ' failed: ' + e);
  }
}

module.exports = { init, play, diag, lastError };
