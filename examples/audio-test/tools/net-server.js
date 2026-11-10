#!/usr/bin/env node
// AppHub 网关反代目标:静态伺服网络曲目(真机 cleartext 只放行 127.0.0.1,必须走网关)。
// 路由:apphubctl route add --app wx3a7f2c9e1b8d4f56 --prefix / --target http://127.0.0.1:9208
// 用法:node tools/net-server.js [端口](默认 9208,根目录 = tools/out)
const http = require('http')
const fs = require('fs')
const path = require('path')

const port = Number(process.argv[2] || 9208)
const root = path.join(__dirname, 'out')

const MIME = { '.wav': 'audio/wav', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.png': 'image/png' }

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0])
  const file = path.normalize(path.join(root, urlPath))
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found: ' + urlPath)
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Accept-Ranges': 'none',
  })
  fs.createReadStream(file).pipe(res)
  console.log(new Date().toISOString().slice(11, 19), 'served', urlPath)
}).listen(port, '127.0.0.1', () => console.log('audio static server on http://127.0.0.1:' + port))
