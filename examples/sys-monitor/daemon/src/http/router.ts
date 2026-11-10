import type { IncomingMessage, ServerResponse } from 'node:http';

import { appendSample, collectStats, computeSummary, readHistory, SampleError } from '../sample.ts';
import type { CollectDeps, SysStats } from '../sample.ts';
import {
  collectProcessDetail,
  collectProcesses,
  KillDeniedError,
  ProcessGoneError,
  PROCESS_TOP_SHOWN,
  killProcess,
} from '../process-sample.ts';
import type { KillProcessDeps, ProcessListPayload } from '../process-sample.ts';
import { verifyBackendToken, backendTokenOf } from './auth.ts';
import { handleHealth, isHealthRequest } from './health.ts';

/**
 * sys-monitor daemon HTTP 数据面（spec-096 FR-1575/1576；#612 修订 /stats 数据源；
 * t_15212ab3 增进程榜面 /processes + 杀进程口子）。
 *
 * 端点族（h5 经哑水管直达，回体即 FR 契约形状）：
 *   GET /stats     — **秒回缓存优先**（#612：main.ts 30s 快档预采样写入；缓存空 =
 *                    daemon 刚启动冷窗 → 回落现采一次，v1 行为兜底）。修「现采
 *                    top -l 2 两拍实测 4s 撞 h5 2s 轮询/6s 超时 → 恒报连接失败」。
 *                    回体仍为 SysStats 契约形状，h5 零改动。
 *   GET /history   — 读账本 + summary 现算（空账本 200 空列合法）
 *   GET /processes — **缓存秒回形态**（#612 铁律同款：30s 快档并采入缓存，
 *                    禁现采直连——top 两拍 4s 必撞 h5 2s 轮询）。冷窗 200 空榜
 *                    （h5「暂无法获取」诚实降级）。展示前 10，采 20 余量。
 *   POST /processes/{pid}/kill — 杀进程口子：三保险（保护名单/快照在场/拒杀
 *                    自身）过闸发 SIGTERM；403 拒杀 / 404 已退出 / 502 权限等。
 *   GET /healthz   — 生命周期探测（恒免鉴权）
 *
 * 鉴权：backend token 在场才执法（`x-baigong-backend-token` 恒定时间比对，
 * /healthz 恒免）；缺席 = 不设防（glm-quota 同款）。
 * 本卡无 MCP/Agent 工具需求（卡内定档：daemon 不接 MCP 面）。
 */

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, detail: string): void {
  sendJson(res, status, { detail });
}

/** /stats 缓存读取面（main.ts 采样闭包注入；返回 null = 冷窗未暖）。 */
export type StatsCacheReader = () => SysStats | null;

/** /processes 缓存读取面（main.ts 30s 快档并采注入；null = 冷窗未暖）。 */
export type ProcessesCacheReader = () => ProcessListPayload | null;

export interface RouterOptions {
  /** 期望 backend token（server.yaml miniapp_backends[].backend_token 同值）。 */
  backendToken?: string;
  /** 测试注入口：透传 collectStats 的 runCmd/now 替身（生产缺省零影响）。 */
  testDeps?: CollectDeps;
  /**
   * #612 预采样缓存读取器（main.ts 注入）。缺席 = v1 行为（每次现采），
   * 旧调用方零破坏。
   */
  statsCache?: StatsCacheReader;
  /**
   * /processes 缓存读取器（main.ts 30s 快档并采注入）。缺席 = 现采兜底
   * （与 /stats 冷窗回落同判据，旧调用方零破坏）。
   */
  processesCache?: ProcessesCacheReader;
  /** kill 口子 deps 注入（runCmd 替身 + daemon 自身 pid；测试假命令出口）。 */
  killDeps?: KillProcessDeps;
}

export function buildSysMonitorRequestHandler(
  options: RouterOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const testDeps = options.testDeps;
  const statsCache = options.statsCache;
  const processesCache = options.processesCache;
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const pathname = url.pathname;

    // /healthz 免鉴权：先于 token 门分流（生命周期探测无业务语义）
    if (isHealthRequest(method, pathname)) {
      handleHealth(res);
      return;
    }

    // backend token 门：配置在场才执法（缺省不设防）
    if (
      options.backendToken !== undefined &&
      options.backendToken !== '' &&
      !verifyBackendToken(options.backendToken, backendTokenOf(req))
    ) {
      sendError(res, 401, 'backend token 缺失或不正确');
      return;
    }

    void route(method, pathname, res, {
      testDeps,
      statsCache,
      processesCache,
      killDeps: options.killDeps,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'daemon_internal_error', error: String(error) }));
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.destroy();
    });
  };
}

interface RouteDeps {
  testDeps?: CollectDeps;
  statsCache?: StatsCacheReader;
  processesCache?: ProcessesCacheReader;
  killDeps?: KillProcessDeps;
}

/** POST /processes/{pid}/kill 路由匹配（无依赖正则单点；非 kill 路由 null）。 */
export function matchKillRoute(method: string, pathname: string): number | null {
  if (method !== 'POST') return null;
  const m = /^\/processes\/(\d+)\/kill$/.exec(pathname);
  return m ? Number(m[1]) : null;
}

async function route(method: string, pathname: string, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (method === 'GET' && pathname === '/stats') {
    // #612：缓存优先秒回；冷窗（null）回落现采（v1 兜底，行为向后兼容）
    const cached = deps.statsCache?.() ?? null;
    if (cached !== null) {
      sendJson(res, 200, cached);
      return;
    }
    try {
      sendJson(res, 200, await collectStats(deps.testDeps));
    } catch (error) {
      if (error instanceof SampleError) sendError(res, 502, error.message);
      else throw error;
    }
    return;
  }
  if (method === 'GET' && pathname === '/history') {
    const points = readHistory();
    sendJson(res, 200, { points, summary: computeSummary(points) });
    return;
  }
  if (method === 'GET' && pathname === '/processes') {
    // #612 铁律：缓存秒回；冷窗（daemon 刚启动）回落现采一次（v1 /stats 同判据），
    // 现采也失败 → 502（h5「暂无法获取」诚实降级，非整卡隐藏）
    const cached = deps.processesCache?.() ?? null;
    if (cached !== null) {
      sendJson(res, 200, { processes: cached.processes.slice(0, PROCESS_TOP_SHOWN), ts: cached.ts });
      return;
    }
    try {
      const payload = await collectProcesses(deps.testDeps);
      sendJson(res, 200, { processes: payload.processes.slice(0, PROCESS_TOP_SHOWN), ts: payload.ts });
    } catch (error) {
      if (error instanceof SampleError) sendError(res, 502, error.message);
      else throw error;
    }
    return;
  }
  const killPid = matchKillRoute(method, pathname);
  if (killPid !== null) {
    await handleKill(killPid, res, deps);
    return;
  }
  if (method === 'GET' && /^\/processes\/\d+$/.test(pathname)) {
    // 详情现查（详情页进页一次；快照缺席也照查——刚启动进程弱化字段如实零值）
    const pid = Number(/^\/processes\/(\d+)$/.exec(pathname)?.[1]);
    try {
      const detail = await collectProcessDetail({
        ...deps.testDeps,
        pid,
        totalMemBytes: deps.statsCache?.()?.mem.totalBytes,
        snapshot: deps.processesCache?.()?.processes,
      });
      if (detail === null) {
        sendError(res, 404, '进程不存在或已结束');
        return;
      }
      sendJson(res, 200, detail);
    } catch (error) {
      if (error instanceof SampleError) sendError(res, 502, error.message);
      else throw error;
    }
    return;
  }
  sendError(res, 404, 'not found');
}

/** kill 口子（错误族 → 状态码单点：403 拒杀 / 404 已退出 / 502 命令失败）。 */
async function handleKill(pid: number, res: ServerResponse, deps: RouteDeps): Promise<void> {
  // 快照闸数据源：30s 缓存优先；冷窗（daemon 刚启动未暖）现采一次兜底——
  // 闸判据「pid 必须出现在最近一次榜」不因冷窗失效
  let snapshot = deps.processesCache?.()?.processes ?? [];
  if (snapshot.length === 0) {
    try {
      snapshot = (await collectProcesses(deps.testDeps)).processes;
    } catch {
      snapshot = [];
    }
  }
  try {
    sendJson(res, 200, await killProcess(pid, snapshot, deps.killDeps));
  } catch (error) {
    if (error instanceof KillDeniedError) sendError(res, 403, error.message);
    else if (error instanceof ProcessGoneError) sendError(res, 404, error.message);
    else if (error instanceof SampleError) sendError(res, 502, error.message);
    else throw error;
  }
}

/**
 * 采样追加（FR-1574 定时器体，v1 形状保留供测试/外部复用；#612 生产定时器
 * 已迁 main.ts sampleTick 双档——缓存 + 账本节流一体）。
 * 采样失败吞错走 stderr（后台采集失败不拖垮 HTTP 面；下一周期再试）。
 * @returns 成功落盘的点（失败 null——测试断言面）。
 */
export async function sampleAndAppend(deps: CollectDeps = {}): Promise<unknown> {
  try {
    const stats = await collectStats(deps);
    return appendSample(stats);
  } catch (error) {
    console.error(JSON.stringify({ event: 'sys_monitor_sample_failed', error: String(error) }));
    return null;
  }
}
