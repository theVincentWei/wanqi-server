#!/usr/bin/env node
/**
 * wanqi-mcp-bridge — 万器小程序后端 → DSH 的工具注册桥(方案 A,1 个进程对 N 个 app)。
 *
 * 数据流(2026-11-11 定稿):
 *   ① 启动/轮询:GET <WANQI_BASE>/api/v1/apps → 每个 app 的 detail
 *     (tools 声明 + gateway 路由),按 {appId, versionCode, tools} 做哈希。
 *   ② 哈希变化 → 向 stdout 发一条 MCP 通知 notifications/tools/list_changed,
 *     dsh-mcp-client 收到后自动重拉 tools/list 并原地换装(两阶段安全换装,
 *     失败保留旧表)——全程不重启 DSH。
 *   ③ tools/call → 反代到 gateway:<WANQI_BASE>/api/v1/apps/<appId><prefix><path>,
 *     享受 server 侧超时封顶/rpm 限流/x-app-* 身份头;桥本身不直连后端端口。
 *
 * 声明来源:bundle.json 的 backend.tools 段(声明即接入,install 时写入
 * app_versions.tools_json;bundle.dart validateToolsManifest 校验)。
 *
 * MCP over stdio:换行分隔 JSON-RPC 2.0。零依赖(Node ≥ 18,fetch 内置)。
 * 环境变量:WANQI_BASE(默认 http://127.0.0.1:7610)、WANQI_POLL_MS(默认 30000,
 * 0 = 关闭轮询,只启动时拉一次)、WANQI_CALL_TIMEOUT_MS(默认 60000)。
 * 日志一律走 stderr(stdout 是协议通道)。
 */
import { createInterface } from 'node:readline';

const WANQI_BASE = (process.env.WANQI_BASE || 'http://127.0.0.1:7610').replace(/\/+$/, '');
const POLL_MS = Number(process.env.WANQI_POLL_MS ?? 30000);
const CALL_TIMEOUT_MS = Number(process.env.WANQI_CALL_TIMEOUT_MS ?? 60000);
const MAX_RESULT_BYTES = 200 * 1024;

const log = (...a) => console.error('[wanqi-mcp-bridge]', ...a);

/** appId → {name, versionCode, tools: [{name, description, inputSchema, appId, method, path, prefix}], hash} */
const state = new Map();
let initialized = false;
let loaded = false; // 至少成功拉过一次全量
let lastHash = '';

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const toolRawName = (appId, name) => `${sanitize(appId)}_${name}`;

async function fetchJson(path, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${WANQI_BASE}${path}`, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickPrefix(routes) {
  // 现状惯例单前缀 "/";多前缀时取 "/" 优先,否则取最短的(声明路径相对挂载根)。
  if (!routes || routes.length === 0) return '/';
  const root = routes.find((r) => r.prefix === '/');
  if (root) return '/';
  return [...routes].sort((a, b) => a.prefix.length - b.prefix.length)[0].prefix || '/';
}

async function refreshApps(notify = true) {
  const list = await fetchJson('/api/v1/apps');
  const apps = Array.isArray(list.apps) ? list.apps : [];
  const next = new Map();
  for (const app of apps) {
    const appId = app.appId;
    if (!appId) continue;
    try {
      const detail = await fetchJson(`/api/v1/apps/${appId}`);
      const manifest = detail.tools && Array.isArray(detail.tools.tools) ? detail.tools : null;
      if (!manifest) continue; // 未声明工具的后端不暴露(声明即接入)
      const prefix = pickPrefix(detail.routes);
      const tools = manifest.tools.map((t) => ({
        rawName: toolRawName(appId, t.name),
        description:
          (typeof t.description === 'string' && t.description.trim()) ||
          `${detail.name || appId} 的 ${t.name}`,
        inputSchema:
          t.params && typeof t.params === 'object'
            ? t.params
            : { type: 'object', properties: {} },
        appId,
        method: String(t.method || 'GET').toUpperCase(),
        path: t.path,
        prefix,
      }));
      if (tools.length === 0) continue;
      next.set(appId, {
        name: detail.name || appId,
        versionCode: detail.versionCode,
        tools,
        hash: JSON.stringify([detail.versionCode, manifest]),
      });
    } catch (err) {
      log(`skip ${appId}: ${err.message}`);
    }
  }
  const hash = JSON.stringify([...next.entries()].map(([id, v]) => [id, v.hash]));
  const changed = loaded && hash !== lastHash;
  state.clear();
  for (const [k, v] of next) state.set(k, v);
  const wasLoaded = loaded;
  loaded = true;
  lastHash = hash;
  if (changed && notify && initialized) {
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    log(`tool list changed → notifications/tools/list_changed (${allTools().length} tools)`);
  } else if (!wasLoaded) {
    log(`loaded ${state.size} app(s), ${allTools().length} tool(s) from ${WANQI_BASE}`);
  }
}

const allTools = () => [...state.values()].flatMap((a) => a.tools);

function toolDescriptors() {
  return allTools().map((t) => ({
    name: t.rawName,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

async function callTool(name, args) {
  const tool = allTools().find((t) => t.rawName === name);
  if (!tool) {
    return errResult(`unknown tool "${name}" — list may be stale, re-syncing`);
  }
  // 路径模板:声明里的 {pid} 这类段从 args 取值替换,剩余参数再走 query/body。
  let path = tool.path;
  const consumed = new Set();
  for (const [k, v] of Object.entries(args || {})) {
    const token = `{${k}}`;
    if (path.includes(token)) {
      path = path.split(token).join(encodeURIComponent(String(v)));
      consumed.add(k);
    }
  }
  const rest = Object.fromEntries(
    Object.entries(args || {}).filter(([k]) => !consumed.has(k)),
  );
  const url = new URL(
    `/api/v1/apps/${encodeURIComponent(tool.appId)}${tool.prefix === '/' ? '' : tool.prefix}${path}`,
    WANQI_BASE,
  );
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const init = { method: tool.method, signal: ac.signal, headers: {} };
    if (tool.method === 'GET' || tool.method === 'DELETE') {
      for (const [k, v] of Object.entries(rest)) {
        if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
      }
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(rest);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    const body =
      text.length > MAX_RESULT_BYTES ? `${text.slice(0, MAX_RESULT_BYTES)}…(truncated)` : text;
    return {
      content: [{ type: 'text', text: body || '(empty response)' }],
      isError: !res.ok,
    };
  } catch (err) {
    const reason =
      err.name === 'AbortError'
        ? `gateway call timed out after ${CALL_TIMEOUT_MS}ms`
        : `gateway call failed: ${err.message}`;
    log(`${name}: ${reason}`);
    return errResult(reason);
  } finally {
    clearTimeout(timer);
  }
}

const errResult = (message) => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          // 回显请求的协议版本(SDK 侧 versionNegotiation auto)。
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'wanqi-mcp-bridge', version: '0.1.0' },
        });
        return;
      case 'notifications/initialized':
        initialized = true;
        log('initialized');
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list': {
        if (!loaded) await refreshApps(false);
        reply(id, { tools: toolDescriptors() });
        return;
      }
      case 'tools/call': {
        if (!loaded) await refreshApps(false);
        reply(id, await callTool(params?.name, params?.arguments));
        return;
      }
      default:
        if (isNotification) return; // 未知通知静默忽略
        replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    log(`error handling ${method}: ${err.stack || err}`);
    if (!isNotification) replyError(id, -32603, `internal error: ${err.message}`);
  }
}

// --- 启动 ---
refreshApps().catch((err) => log(`initial fetch failed (will retry via tools/list): ${err.message}`));

if (POLL_MS > 0) {
  const timer = setInterval(() => {
    refreshApps().catch((err) => log(`poll failed: ${err.message}`));
  }, POLL_MS);
  timer.unref();
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`dropping non-JSON line`);
    return;
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));
