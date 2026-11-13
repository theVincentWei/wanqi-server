#!/usr/bin/env node
/**
 * wanqi-web-sync —— 把万器(:7610)市场已上架的 Dimina 包镜像进 dimina Web 容器。
 *
 * 改装背景(2026-11-13,用户拍板):dimina fe/packages/container 的 Web 容器已加
 * 万器网关同源分流(vite proxy /api/v1、/icons + 容器 request 胶水分支),浏览器里
 * 也能调 127.0.0.1:7610 网关;本脚本负责把市场包(zip)解压成容器要的静态布局:
 *   public/<appId>/main/...      ← zip 里的 main/ 解开即位
 *   public/<appId>/icon.png      ← 市场图标,appList logo 引用
 *   public/appList.json          ← 合并登记 {appId, name, path, logo, versionCode}
 *
 * 用法:
 *   node wanqi-web-sync.mjs                       # 同步 :7610 全部已上架包
 *   node wanqi-web-sync.mjs --only wx1234,wx5678  # 只同步指定 appId
 *   node wanqi-web-sync.mjs --server http://127.0.0.1:7620   # 测试环境
 *   node wanqi-web-sync.mjs --list                # 只列市场包不解压
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
	const out = { server: 'http://127.0.0.1:7610', only: null, list: false }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--server') out.server = argv[++i]
		else if (a === '--only') out.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
		else if (a === '--list') out.list = true
		else throw new Error(`unknown arg: ${a}`)
	}
	return out
}

async function getJson(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
	return res.json()
}

async function downloadTo(url, dest) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
	const buf = Buffer.from(await res.arrayBuffer())
	fs.writeFileSync(dest, buf)
	return buf.length
}

async function unzipTo(zipPath, destDir) {
	fs.rmSync(destDir, { recursive: true, force: true })
	fs.mkdirSync(destDir, { recursive: true })
	await execFileAsync('unzip', ['-oq', zipPath, '-d', destDir])
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const server = args.server.replace(/\/$/, '')
	const publicDir = path.join(os.homedir(), 'Code/dimina/fe/packages/container/public')

	const listBody = await getJson(`${server}/api/v1/apps`)
	const apps = Array.isArray(listBody) ? listBody : (listBody.apps ?? listBody.data ?? [])
	if (!Array.isArray(apps) || apps.length === 0) {
		console.error(`市场列表为空或格式不认识:${server}/api/v1/apps`)
		process.exit(1)
	}

	const targets = args.only ? apps.filter(a => args.only.includes(a.appId)) : apps
	if (targets.length === 0) {
		console.error(`--only 没匹配到任何包。市场上现有:${apps.map(a => `${a.appId}(${a.name})`).join(', ')}`)
		process.exit(1)
	}

	console.log(`市场:${server}  待同步 ${targets.length} 个包  public:${publicDir}`)
	if (args.list) {
		for (const a of targets) console.log(`  ${a.appId}  v${a.versionCode}  ${a.name}  entry=${a.path}`)
		return
	}
	fs.mkdirSync(publicDir, { recursive: true })

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanqi-web-sync-'))
	const synced = []
	const failed = []

	for (const app of targets) {
		const { appId, name } = app
		try {
			const manifest = await getJson(`${server}/apps/${appId}/manifest.json`)
			const entry = manifest.path || app.path || 'pages/index/index'
			const zipName = `${appId}-${manifest.versionCode}.zip`
			const zipPath = path.join(tmpDir, zipName)
			const zipUrl = new URL(manifest.packageUrl, server).href
			const size = await downloadTo(zipUrl, zipPath)

			const appDir = path.join(publicDir, appId)
			await unzipTo(zipPath, appDir)

			// 布局自检:容器按 <appId>/main/app-config.json 取资源(game 包是 main/game 入口)
			const mainDir = path.join(appDir, 'main')
			if (!fs.existsSync(mainDir)) throw new Error('zip 解开后没有 main/ 目录,布局对不上')
			if (!fs.existsSync(path.join(mainDir, 'app-config.json'))) {
				console.warn(`  ⚠ ${appId}: main/app-config.json 不存在(game 包?),先解压不拦`)
			}

			let logo = `/${appId}/icon.png`
			if (manifest.iconUrl) {
				try {
					await downloadTo(new URL(manifest.iconUrl, server).href, path.join(appDir, 'icon.png'))
				}
				catch (err) {
					logo = '' // 拉不到就留空,容器首页会自动生成色块 logo
					console.warn(`  ⚠ ${appId} 图标拉取失败:${err.message}`)
				}
			}

			synced.push({ appId, name, path: entry, logo, versionCode: manifest.versionCode })
			console.log(`  ✓ ${appId}  v${manifest.versionCode}  ${name}  entry=${entry}  zip=${(size / 1024).toFixed(0)}KB`)
		}
		catch (err) {
			failed.push({ appId, name, error: err.message })
			console.error(`  ✗ ${appId}  ${name}: ${err.message}`)
		}
	}

	// appList.json 合并:替换本次同步的 appId 条目,其余(examples 编译产物等)原样保留
	const appListPath = path.join(publicDir, 'appList.json')
	let existing = []
	if (fs.existsSync(appListPath)) {
		try { existing = JSON.parse(fs.readFileSync(appListPath, 'utf8')) } catch {}
		if (!Array.isArray(existing)) existing = []
	}
	const syncedIds = new Set(synced.map(a => a.appId))
	const merged = [...existing.filter(a => !syncedIds.has(a.appId)), ...synced]
	fs.writeFileSync(appListPath, JSON.stringify(merged, null, 2))
	console.log(`appList.json:共 ${merged.length} 条(万器同步 ${synced.length},原有 ${merged.length - synced.length})`)

	if (failed.length) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
