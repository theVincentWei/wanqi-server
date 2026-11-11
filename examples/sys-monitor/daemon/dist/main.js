"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDaemonServer = startDaemonServer;
exports.portFromEnv = portFromEnv;
exports.intervalSecFromEnv = intervalSecFromEnv;
exports.cacheSecFromEnv = cacheSecFromEnv;
const node_http_1 = require("node:http");
const router_ts_1 = require("./http/router.js");
const sample_ts_1 = require("./sample.js");
const process_sample_ts_1 = require("./process-sample.js");
/**
 * sys-monitor daemon 入口（spec-096 FR-1574/1578；#612 修订采样面）：
 *
 * ① HTTP 数据面：裸 node:http，绑 127.0.0.1（Server 哑水管转发目标）。
 *    端口 env 优先级：`APPHUB_PORT`（wanqi/Bundle v1 托管注入，规范写死）
 *    > `BAIGONG_HEALTH_PORT`（dsh-go 安装腿注入）> `SYS_MONITOR_DAEMON_PORT`
 *    （spec-096 开发缺省 **9207**）；server.yaml miniapp_backends 条目的
 *    backend_token 经 env 注入执法（可选）。
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
async function startDaemonServer(options = {}) {
    // 每实例独立缓存（闭包态）：多 server 并存（测试 sequential spawn）零串扰
    let latestStats = null;
    let latestProcesses = null;
    let lastAppendMs = 0;
    let sampling = false;
    const sampleTick = async () => {
        if (sampling)
            return; // 上一拍未完（慢命令/低档位）→ 跳过本拍，防 spawn 叠加
        sampling = true;
        try {
            // 进程榜与整机采样**并采**（同一快档写两份缓存，30s 一拍节奏不变；
            // 分支互不连坐：进程榜失败吞错不拖垮 /stats，反之亦然）
            void (0, process_sample_ts_1.collectProcesses)(options.testDeps)
                .then((payload) => {
                latestProcesses = payload;
            })
                .catch((error) => {
                console.error(JSON.stringify({ event: 'sys_monitor_processes_failed', error: String(error) }));
            });
            const stats = await (0, sample_ts_1.collectStats)(options.testDeps);
            latestStats = stats;
            if (Date.now() - lastAppendMs >= intervalSec * 1000) {
                (0, sample_ts_1.appendSample)(stats);
                lastAppendMs = Date.now();
            }
            if (!warmed) {
                warmed = true;
                console.log(JSON.stringify({ event: 'sys_monitor_cache_warmed', cpuPct: stats.cpu.pct }));
            }
        }
        catch (error) {
            // 后台采集失败吞错走 stderr（不拖垮 HTTP 面；下一拍再试——v1 sampleAndAppend 同判）
            console.error(JSON.stringify({ event: 'sys_monitor_sample_failed', error: String(error) }));
        }
        finally {
            sampling = false;
        }
    };
    const handler = (0, router_ts_1.buildSysMonitorRequestHandler)({
        backendToken: options.backendToken,
        testDeps: options.testDeps,
        statsCache: () => latestStats,
        processesCache: () => latestProcesses,
        killDeps: { runCmd: options.testDeps?.runCmd, selfPid: process.pid },
    });
    const server = (0, node_http_1.createServer)(handler);
    // 端口统一走 portFromEnv：APPHUB_PORT（Bundle v1）> BAIGONG_HEALTH_PORT（dsh-go
    // 安装腿，FR-1654）> SYS_MONITOR_DAEMON_PORT（spec-096 缺省 9207 仅开发裸跑缺省面）。
    const port = options.port ?? portFromEnv();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.host ?? '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const address = server.address();
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
        close: () => new Promise((resolve, reject) => {
            clearInterval(timer);
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    };
}
/** 端口 env 解析（glm-quota portFromEnv 同款；坏值落缺省不崩）。
 *  优先级：APPHUB_PORT（Bundle v1 托管注入）> BAIGONG_HEALTH_PORT（dsh-go 安装腿）
 *  > SYS_MONITOR_DAEMON_PORT（spec-096 开发口）> 9207。 */
function portFromEnv(env = process.env) {
    const candidates = [env.APPHUB_PORT, env.BAIGONG_HEALTH_PORT, env.SYS_MONITOR_DAEMON_PORT];
    for (const raw of candidates) {
        const trimmed = raw?.trim();
        if (trimmed !== undefined && trimmed !== '') {
            const parsed = Number(trimmed);
            if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536)
                return parsed;
        }
    }
    return DEFAULT_PORT;
}
/** 账本间隔解析：options.intervalSec > env SYS_MONITOR_INTERVAL_SEC > 300（坏值/≤0 落下一级）。 */
function intervalSecFromEnv(options = {}, env = process.env) {
    if (options.intervalSec !== undefined && Number.isFinite(options.intervalSec) && options.intervalSec > 0) {
        return options.intervalSec;
    }
    const raw = env.SYS_MONITOR_INTERVAL_SEC?.trim();
    if (raw !== undefined && raw !== '') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    return DEFAULT_INTERVAL_SEC;
}
/** 缓存档间隔解析：options.cacheSec > env SYS_MONITOR_CACHE_SEC > 30（坏值/≤0 落下一级）。 */
function cacheSecFromEnv(options = {}, env = process.env) {
    if (options.cacheSec !== undefined && Number.isFinite(options.cacheSec) && options.cacheSec > 0) {
        return options.cacheSec;
    }
    const raw = env.SYS_MONITOR_CACHE_SEC?.trim();
    if (raw !== undefined && raw !== '') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    return DEFAULT_CACHE_SEC;
}
async function main() {
    // FR-1654（spec 109 v0.60）安装注入链接管形态：token 通道单一来源——
    // 注入腿 env BAIGONG_BACKEND_TOKEN 在场优先，回落 spec-096 手工条目 env 名。
    // 端口统一走 portFromEnv（APPHUB_PORT > BAIGONG_HEALTH_PORT > SYS_MONITOR_DAEMON_PORT > 9207）。
    const backendToken = process.env.BAIGONG_BACKEND_TOKEN ?? process.env.SYS_MONITOR_BACKEND_TOKEN;
    const handle = await startDaemonServer({
        port: portFromEnv(),
        backendToken: backendToken !== undefined && backendToken !== '' ? backendToken : undefined,
        warmup: true,
    });
    console.log(JSON.stringify({ event: 'sys_monitor_daemon_started', port: handle.port, intervalSec: handle.intervalSec, cacheSec: handle.cacheSec }));
    const shutdown = () => {
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
