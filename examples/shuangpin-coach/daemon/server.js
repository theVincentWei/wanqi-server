#!/usr/bin/env node
// 双拼教练 · M3 听音数据面 daemon（node 零依赖，源码进仓）
// 部署：~/dsh/apphub/backends/wx3d8b6f2a9c4e7d15/（本文件 + manifest.json + audio/）
// 启动：launchd label app.dsh.apphub.shuangpin-coach（plist 见 ~/Library/LaunchAgents/）
//
// 端点（SPEC-M3 §1.2）：
//   GET /health                     -> {"ok":true}
//   GET /manifest.json              -> 音频清单 JSON（= utils/audio.js 的数据体）
//   GET /audio/c/<cp16>.mp3         -> 单字音频   audio/mpeg + max-age=31536000
//   GET /audio/ex/<cp16>.mp3        -> 例词音频   audio/mpeg + max-age=31536000
// 防穿越：audio 路径硬校验 ^audio/(c|ex)/[0-9a-f]+\.mp3$，其余一律 404。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9215;
const ROOT = __dirname; // 静态根 = 部署目录
const AUDIO_RE = /^audio\/(c|ex)\/[0-9a-f]+\.mp3$/;

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendFile(res, abs, contentType, cacheControl) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return sendJSON(res, 404, { ok: false, error: 'not found' });
  }
  if (!st.isFile()) return sendJSON(res, 404, { ok: false, error: 'not found' });
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': st.size,
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(function (req, res) {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'bad url' });
  }
  let pathname = decodeURIComponent(u.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  }

  if (pathname === 'health') {
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === 'manifest.json') {
    return sendFile(res, path.join(ROOT, 'manifest.json'), 'application/json; charset=utf-8', 'no-cache');
  }
  if (AUDIO_RE.test(pathname)) {
    // ?b64=1 → JSON {b64}：容器 wx.request 对二进制(arraybuffer)支持不佳，
    // 走 JSON 文本通道由客户端拼 data-URI（CDP 实证可播）。
    if (u.searchParams.get('b64') === '1') {
      let buf;
      try {
        buf = fs.readFileSync(path.join(ROOT, pathname));
      } catch (e) {
        return sendJSON(res, 404, { ok: false, error: 'not found' });
      }
      return sendJSON(res, 200, { b64: buf.toString('base64') });
    }
    return sendFile(res, path.join(ROOT, pathname), 'audio/mpeg', 'max-age=31536000, immutable');
  }
  return sendJSON(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('[spc-daemon] listening on 127.0.0.1:' + PORT + ' root=' + ROOT);
});

process.on('uncaughtException', function (err) {
  console.error('[spc-daemon] uncaught:', err && err.message);
});
process.on('unhandledRejection', function (err) {
  console.error('[spc-daemon] unhandled rejection:', err && (err.message || err));
});
