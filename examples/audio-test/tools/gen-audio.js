#!/usr/bin/env node
// 生成验收用测试曲目(纯 PCM WAV,无外部依赖):
//   bundle-melody.wav —— 包内曲目,4 段各 1s 的上行音阶,便于听感核对 seek/倍速
//   net-echo.wav      —— 网络曲目,下行音阶 + 颤音,由 AppHub 网关反代经真机播放
// 用法:node tools/gen-audio.js [输出目录](默认 tools/out)
const fs = require('fs')
const path = require('path')

const SAMPLE_RATE = 22050

function writeWav(file, samples) {
  const dataSize = samples.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  }
  fs.writeFileSync(file, buf)
  console.log('wrote', file, (buf.length / 1024).toFixed(1) + 'KB')
}

// 按 [起,止] 秒生成段内恒定频率 + 10ms 淡入淡出的正弦段
function tone(freq, startSec, durSec, gain = 0.6) {
  const start = Math.round(startSec * SAMPLE_RATE)
  const len = Math.round(durSec * SAMPLE_RATE)
  const edge = Math.round(0.01 * SAMPLE_RATE)
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE
    const env = Math.min(1, i / edge, (len - i) / edge)
    tone.samples[start + i] = (tone.samples[start + i] || 0) + Math.sin(2 * Math.PI * freq * t) * gain * env
  }
}

function melody(freqs, vibrato) {
  tone.samples = new Array(Math.round(freqs.length * SAMPLE_RATE)).fill(0)
  freqs.forEach((f, idx) => {
    const startSec = idx
    if (vibrato) {
      // 频率按 5Hz 颤音摆动,幅度 ±6%
      const start = Math.round(startSec * SAMPLE_RATE)
      const len = SAMPLE_RATE
      const edge = Math.round(0.01 * SAMPLE_RATE)
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE
        const env = Math.min(1, i / edge, (len - i) / edge)
        const inst = f * (1 + 0.06 * Math.sin(2 * Math.PI * 5 * t))
        tone.samples[start + i] += Math.sin(2 * Math.PI * inst * t) * 0.6 * env
      }
    }
    else {
      tone(f, startSec, 1)
    }
  })
  return tone.samples
}

const outDir = process.argv[2] || path.join(__dirname, 'out')
fs.mkdirSync(outDir, { recursive: true })

// 上行:220.5 → 822,每段 1s,共 4s
writeWav(path.join(outDir, 'bundle-melody.wav'), melody([220.5, 330, 440, 660, 822]))
// 下行 + 颤音:660 → 220.5,共 3s
writeWav(path.join(outDir, 'net-echo.wav'), melody([660, 495, 330, 220.5], true))
