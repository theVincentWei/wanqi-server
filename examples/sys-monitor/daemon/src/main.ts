import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildSysMonitorRequestHandler } from './http/router.ts';
import { appendSample, collectStats } from './sample.ts';
import type { CollectDeps, SysStats } from './sample.ts';
import { collectProcesses } from './process-sample.ts';
import type { ProcessListPayload } from './process-sample.ts';

/**
 * sys-monitor daemon 入口（spec-096 FR-1574/1578；#612 修订采样面）：
 *
 * ① HTTP 数据面：裸 node:http，绑 127.0.0.1（Server 哑水管转发目标）。
 *    端口 env `SYS_MONITOR_DAEMON_PORT` 缺省 **9207**（spec-096 定档）；
 *    server.yaml miniapp_backends 条目的 backend_token 经 env 注入执法（可选）。
 * ② 采集定时器（#612 双档修订：**唯一常驻句柄不变**，FR-1578 纪律照守）：
 *    - 快档（缓存档）：env `SYS_MONITOR_CACHE_SEC` 缺省 30s 一拍，现采 →
 *      写内存缓存（/stats 秒回数据源；修「现采 top -l 2 两拍 4s 撞 h5 2s 轮询
 *      必超时」——采样的 4s 留在后台，与「等你拿数」彻底解耦）；
 *    - 慢档（账本档）：距上次落账 ≥ `SYS_MONITOR_INTERVAL_SEC`（缺省 300s）
 *      才 appendSample 落历史账（账本节奏与 v1 完全一致，≤288 滚动不变）。
 *    - 采集进行中（sampling 旗标）跳过本拍，防慢命令下 spawn 叠加；
 *    - `warmup: true`（生产入口）启动即后台暖一拍，缩短冷窗；冷窗期 /stats
 *      回落现采（v1 行为，router 兼容面）。
 */

const DEFAULT_PORT = 9207;
const DEFAULT_INTERVAL_SEC = 300;
const DEFAULT_CACHE_SEC = 30;

export interface DaemonHandle {
  server: ReturnType<typeof createServer>;
  port: number;
  intervalSec: number;
  cacheSec: number;
  stopSampler(): void;
  close(): Promise<void>;
}

export interface DaemonOptions {
  port?: number;
  host?: string;
  /** server.yaml miniapp_backends[].backend_token 注入口（测试/部署同形）。 */
  backendToken?: string;
  /** 账本落账间隔秒（缺省读 env，再缺省 300；≤0 落缺省）。 */
  intervalSec?: number;
  /** 缓存档采样间隔秒（缺省读 env，再缺省 30；≤0 落缺省）。 */
  cacheSec?: number;
  /** 启动即后台暖一拍（生产入口 true；库缺省 false，测试时序零扰动）。 */
  warmup?: boolean;
  /** 测试注入口：透传采样层 runCmd/now 替身（生产缺省零影响）。 */
  testDeps?: CollectDeps;
}

export async function startDaemonServer(options: DaemonOptions = {}): Promise<DaemonHandle> {
  // 每实例独立缓存（闭包态）：多 server 并存（测试 sequential spawn）零串扰
  let latestStats: SysStats | null = null;
  let latestProcesses: ProcessListPayload | null = null;
  let lastAppendMs = 0;
  let sampling = false;

  const sampleTick = async (): Promise<void> => {
    if (sampling) return; // 上一拍未完（慢命令/低档位）→ 跳过本拍，防 spawn 叠加
    sampling = true;
    try {
      // 进程榜与整机采样**并采**（同一快档写两份缓存，30s 一拍节奏不变；
      // 分支互不连坐：进程榜失败吞错不拖垮 /stats，反之亦然）
      void collectProcesses(options.testDeps)
        .then((payload) => {
          latestProcesses = payload;
        })
        .catch((error: unknown) => {
          console.error(JSON.stringify({ event: 'sys_monitor_processes_failed', error: String(error) }));
        });
      const stats = await collectStats(options.testDeps);
      latestStats = stats;
      if (Date.now() - lastAppendMs >= intervalSec * 1000) {
        appendSample(stats);
        lastAppendMs = Date.now();
      }
      if (!warmed) {
        warmed = true;
        console.log(JSON.stringify({ event: 'sys_monitor_cache_warmed', cpuPct: stats.cpu.pct }));
      }
    } catch (error) {
      // 后台采集失败吞错走 stderr（不拖垮 HTTP 面；下一拍再试——v1 sampleAndAppend 同判）
      console.error(JSON.stringify({ event: 'sys_monitor_sample_failed', error: String(error) }));
    } finally {
      sampling = false;
    }
  };

  const handler = buildSysMonitorRequestHandler({
    backendToken: options.backendToken,
    testDeps: options.testDeps,
    statsCache: () => latestStats,
    processesCache: () => latestProcesses,
    killDeps: { runCmd: options.testDeps?.runCmd, selfPid: process.pid },
  });
  const server = createServer(handler as (req: IncomingMessage, res: ServerResponse) => void);
  // FR-1654（spec 109 v0.60）安装注入链接管形态：BAIGONG_HEALTH_PORT env 在场
  // （FR-1651 注入腿端口通道）→ 注入端口优先（安装腿派生端口是真值；spec-096
  // 缺省 9207 仅开发裸跑缺省面）。
  const injected = Number.parseInt(process.env.BAIGONG_HEALTH_PORT ?? '', 10);
  const port = options.port ?? (Number.isInteger(injected) && injected > 0 ? injected : portFromEnv());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const intervalSec = intervalSecFromEnv(options);
  const cacheSec = cacheSecFromEnv(options);
  let warmed = false;
  const timer = setInterval(() => {
    void sampleTick();
  }, cacheSec * 1000);
  // 采样定时器不许持事件循环（进程退出面归 HTTP server + 显式信号处理）
  timer.unref();
  if (options.warmup === true) {
    // 启动暖拍：后台即刻采一笔填缓存（不等首拍 30s；冷窗期 /stats 仍有现采兜底）
    void sampleTick();
  }
  return {
    server,
    port: address.port,
    intervalSec,
    cacheSec,
    stopSampler: () => clearInterval(timer),
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(timer);
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** 端口 env 解析（glm-quota portFromEnv 同款；坏值落缺省不崩）。 */
export function portFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SYS_MONITOR_DAEMON_PORT?.trim();
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

/** 账本间隔解析：options.intervalSec > env SYS_MONITOR_INTERVAL_SEC > 300（坏值/≤0 落下一级）。 */
export function intervalSecFromEnv(options: Pick<DaemonOptions, 'intervalSec'> = {}, env: NodeJS.ProcessEnv = process.env): number {
  if (options.intervalSec !== undefined && Number.isFinite(options.intervalSec) && options.intervalSec > 0) {
    return options.intervalSec;
  }
  const raw = env.SYS_MONITOR_INTERVAL_SEC?.trim();
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INTERVAL_SEC;
}

/** 缓存档间隔解析：options.cacheSec > env SYS_MONITOR_CACHE_SEC > 30（坏值/≤0 落下一级）。 */
export function cacheSecFromEnv(options: Pick<DaemonOptions, 'cacheSec'> = {}, env: NodeJS.ProcessEnv = process.env): number {
  if (options.cacheSec !== undefined && Number.isFinite(options.cacheSec) && options.cacheSec > 0) {
    return options.cacheSec;
  }
  const raw = env.SYS_MONITOR_CACHE_SEC?.trim();
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CACHE_SEC;
}

async function main(): Promise<void> {
  // FR-1654（spec 109 v0.60）安装注入链接管形态：token 通道单一来源——
  // 注入腿 env BAIGONG_BACKEND_TOKEN 在场优先，回落 spec-096 手工条目 env 名。
  const backendToken = process.env.BAIGONG_BACKEND_TOKEN ?? process.env.SYS_MONITOR_BACKEND_TOKEN;
  const injectedPort = Number.parseInt(process.env.BAIGONG_HEALTH_PORT ?? '', 10);
  const handle = await startDaemonServer({
    port: Number.isInteger(injectedPort) && injectedPort > 0 ? injectedPort : portFromEnv(),
    backendToken: backendToken !== undefined && backendToken !== '' ? backendToken : undefined,
    warmup: true,
  });
  console.log(JSON.stringify({ event: 'sys_monitor_daemon_started', port: handle.port, intervalSec: handle.intervalSec, cacheSec: handle.cacheSec }));
  const shutdown = (): void => {
    void handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  void main();
}
