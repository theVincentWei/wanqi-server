"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultRunCmd = exports.SampleError = exports.HISTORY_MAX_POINTS = exports.DATA_VOLUME_MOUNT = exports.PLUGIN_ID = void 0;
exports.resolveBaigongHome = resolveBaigongHome;
exports.historyPath = historyPath;
exports.parseMemSizeToken = parseMemSizeToken;
exports.parseTopOutput = parseTopOutput;
exports.parseVmStat = parseVmStat;
exports.memFromVmStat = memFromVmStat;
exports.parseDf = parseDf;
exports.parseUptimeBody = parseUptimeBody;
exports.parseUptime = parseUptime;
exports.collectStats = collectStats;
exports.readHistory = readHistory;
exports.writeHistory = writeHistory;
exports.appendSample = appendSample;
exports.computeSummary = computeSummary;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
/**
 * sys-monitor daemon 采样层（spec-096 FR-1574/1576/1578）。
 *
 * macOS 采样判据（卡内定档，数值口径 = 活动监视器同路径）：
 * - CPU：`top -l 2 -n 0 -s 2` 两拍，解析**第二拍** `CPU usage:` 行（单拍是自启动
 *   累计均值，数值失真）——一次 spawn 同时拿全 CPU + 内存（PhysMem 行）。
 * - 内存：主判 = top PhysMem 行（used/compressor），totalBytes = `sysctl hw.memsize`；
 *   PhysMem 缺席时回退 `vm_stat` + hw.memsize 页级计算（等价路径，同样夹具单测）。
 * - 磁盘：`df -k /System/Volumes/Data`（数据卷，非根卷），pct = used/(used+avail)。
 * - 负载/开机时长：`uptime` 一行（load averages 三值 + up 段）。
 *
 * 资源纪律（FR-1578）：采样只在本模块被调用时 spawn；常驻面仅 main.ts 的一个
 * setInterval。历史 ≤288 点滚动 + tmp+rename 原子写。
 */
exports.PLUGIN_ID = 'sys-monitor';
exports.DATA_VOLUME_MOUNT = '/System/Volumes/Data';
exports.HISTORY_MAX_POINTS = 288;
/** 采样失败（命令缺席/输出不合预期）——HTTP 面 502 {detail}。 */
class SampleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SampleError';
    }
}
exports.SampleError = SampleError;
/** <home> 解析（glm-quota daemon resolveBaigongHome 同判据：WANQI_HOME 新优先、BAIGONG_HOME 兼容；显式 env 不自动迁移）。 */
function resolveBaigongHome(env = process.env) {
    const wanqi = env.WANQI_HOME?.trim();
    if (wanqi)
        return wanqi;
    const baigong = env.BAIGONG_HOME?.trim();
    if (baigong)
        return baigong;
    return (0, node_path_1.join)((0, node_os_1.homedir)(), '.wanqi');
}
/** 历史账本路径：<home>/data/miniapps/sys-monitor/history.json（FR-1574/#529 布局定档）。 */
function historyPath(home = resolveBaigongHome()) {
    return (0, node_path_1.join)(home, 'data', 'miniapps', exports.PLUGIN_ID, 'history.json');
}
// ── 解析层（纯函数；单测用夹具文本，禁真 spawn）─────────────────────────────
/** "7169M" / "2.5G" / "512K" → bytes（top PhysMem 单位面；非法返回 null）。 */
function parseMemSizeToken(token) {
    const m = /^([\d.]+)\s*([KMGTP])$/i.exec(token.trim());
    if (!m)
        return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value))
        return null;
    const unit = m[2].toUpperCase();
    const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
    return Math.round(value * mult[unit]);
}
/**
 * top -l 2 输出解析：多拍输出里同名行取**最后一次**出现（= 第二拍真窗口值）。
 * 夹具形：
 *   CPU usage: 6.93% user, 14.61% sys, 78.45% idle
 *   PhysMem: 7169M used (1526M wired, 2604M compressor), 190M unused
 */
function parseTopOutput(text) {
    const out = {
        userPct: 0, sysPct: 0, idlePct: 0, pct: 0,
        memUsedBytes: null, memUnusedBytes: null, memCompressBytes: null, memWiredBytes: null,
        hasCpuLine: false, hasPhysMemLine: false,
    };
    const cpuRe = /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/gi;
    let m;
    while ((m = cpuRe.exec(text)) !== null) {
        out.userPct = Number(m[1]);
        out.sysPct = Number(m[2]);
        out.idlePct = Number(m[3]);
        out.hasCpuLine = true;
    }
    const physRe = /PhysMem:\s*([\d.]+[KMGTP])\s*used\s*(?:\(([^)]*)\))?,\s*([\d.]+[KMGTP])\s*unused/gi;
    let pm;
    while ((pm = physRe.exec(text)) !== null) {
        // 多拍输出同名行取最后一次（= 第二拍真窗口值，与 CPU usage 行同判据）
        out.memUsedBytes = parseMemSizeToken(pm[1]);
        out.memUnusedBytes = parseMemSizeToken(pm[3]);
        out.hasPhysMemLine = true;
        const detail = pm[2] ?? '';
        const wired = /([\d.]+[KMGTP])\s*wired/i.exec(detail);
        if (wired)
            out.memWiredBytes = parseMemSizeToken(wired[1]);
        const comp = /([\d.]+[KMGTP])\s*compressor/i.exec(detail);
        if (comp)
            out.memCompressBytes = parseMemSizeToken(comp[1]);
    }
    return out;
}
/** vm_stat 输出解析（回退路径；页大小从首行 `page size of N bytes` 读，缺席按 16384）。 */
function parseVmStat(text) {
    const num = (label) => {
        const m = label.exec(text);
        return m ? Number(m[1].replace(/,/g, '')) || 0 : 0;
    };
    const sizeM = /page size of\s+(\d+)\s+bytes/i.exec(text);
    return {
        pageSize: sizeM ? Number(sizeM[1]) || 16384 : 16384,
        freePages: num(/Free (?:pages|page count):\s*([\d,]+)/i),
        speculativePages: num(/Pages speculative:\s*([\d,]+)/i),
        purgeablePages: num(/Pages purgeable:\s*([\d,]+)/i),
        compressorPages: num(/Pages (?:stored in compressor|compressor):\s*([\d,]+)/i),
        wiredPages: num(/Pages wired down:\s*([\d,]+)/i),
        activePages: num(/Pages active:\s*([\d,]+)/i),
        inactivePages: num(/Pages inactive:\s*([\d,]+)/i),
    };
}
/** vm_stat 页数 + hw.memsize → 内存三值（活动监视器近似口径：avail = free+speculative+purgeable）。 */
function memFromVmStat(vm, totalBytes) {
    const availPages = vm.freePages + vm.speculativePages + vm.purgeablePages;
    const availBytes = Math.min(totalBytes, availPages * vm.pageSize);
    const compressBytes = vm.compressorPages * vm.pageSize;
    const usedBytes = Math.max(0, totalBytes - availBytes);
    return { usedBytes, availBytes, compressBytes };
}
/** df -k 输出解析：按 mount 点定位行（cols: Filesystem blocks used avail … Mounted on）。 */
function parseDf(text, mount = exports.DATA_VOLUME_MOUNT) {
    for (const line of text.split('\n')) {
        if (!line.includes(mount))
            continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4)
            continue;
        const blocks = Number(cols[1]);
        const used = Number(cols[2]);
        const avail = Number(cols[3]);
        if (!Number.isFinite(blocks) || !Number.isFinite(used) || !Number.isFinite(avail))
            continue;
        const totalBytes = (used + avail) * 1024;
        return {
            usedBytes: used * 1024,
            availBytes: avail * 1024,
            totalBytes,
            pct: totalBytes > 0 ? (used * 1024) / totalBytes * 100 : 0,
        };
    }
    return null;
}
/** uptime up 段解析：逗号分段累加——'11 days,  7:02'（天+时:分）/ '3:45' / '2 mins' / '1 day, 3:45:12' → 秒。 */
function parseUptimeBody(body) {
    let total = 0;
    for (const seg of body.split(',')) {
        const text = seg.trim();
        if (text === '')
            continue;
        const dm = /^(\d+)\s+(days?|hrs?|hours?|mins?|minutes?|secs?|seconds?)$/i.exec(text);
        if (dm) {
            const value = Number(dm[1]);
            const unit = dm[2].toLowerCase();
            if (unit.startsWith('day'))
                total += value * 86400;
            else if (unit.startsWith('h'))
                total += value * 3600;
            else if (unit.startsWith('m'))
                total += value * 60;
            else
                total += value;
            continue;
        }
        const colon = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(text);
        if (colon) {
            total += Number(colon[1]) * 3600 + Number(colon[2]) * 60 + (colon[3] ? Number(colon[3]) : 0);
        }
    }
    return total;
}
/** uptime 命令整行解析。夹具形：`14:33  up 11 days,  7:02, 12 users, load averages: 1.71 4.51 8.14`。 */
function parseUptime(text) {
    const loadRe = /load(?:\s+averages?)?:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i;
    const lm = loadRe.exec(text);
    const upRe = /\bup\s+(.+?),\s+\d+\s+users?/i;
    const um = upRe.exec(text);
    return {
        load1: lm ? Number(lm[1]) : 0,
        load5: lm ? Number(lm[2]) : 0,
        load15: lm ? Number(lm[3]) : 0,
        uptimeSec: um ? parseUptimeBody(um[1]) : 0,
    };
}
const defaultRunCmd = (cmd, args) => execFileAsync(cmd, args, { timeout: 15_000 }).then((r) => r.stdout);
exports.defaultRunCmd = defaultRunCmd;
/** 一次现采（FR-1575 /stats 数据源）：top 一次拿 CPU+内存，其余并行。 */
async function collectStats(deps = {}) {
    const runCmd = deps.runCmd ?? exports.defaultRunCmd;
    const now = deps.now ?? Date.now;
    const topOut = await runCmd('/usr/bin/top', ['-l', '2', '-n', '0', '-s', '2']);
    const top = parseTopOutput(topOut);
    if (!top.hasCpuLine) {
        throw new SampleError('top 输出异常（未检得 CPU usage 行），无法采样 CPU 占用率');
    }
    let memUsed;
    let memAvail;
    let memCompress;
    let memTotal;
    const memsizeOut = await runCmd('/usr/sbin/sysctl', ['-n', 'hw.memsize']);
    memTotal = Number(memsizeOut.trim());
    if (top.hasPhysMemLine && top.memUsedBytes !== null) {
        memUsed = top.memUsedBytes;
        memAvail = Math.max(0, memTotal - memUsed);
        memCompress = top.memCompressBytes ?? 0;
    }
    else {
        // 回退路径：PhysMem 缺席 → vm_stat 页级计算（FR-1574 等价判据）
        const vmOut = await runCmd('/usr/bin/vm_stat', []);
        const vm = parseVmStat(vmOut);
        const calc = memFromVmStat(vm, memTotal);
        memUsed = calc.usedBytes;
        memAvail = calc.availBytes;
        memCompress = calc.compressBytes;
    }
    const [dfOut, upOut, ncpuOut] = await Promise.all([
        runCmd('/bin/df', ['-k', exports.DATA_VOLUME_MOUNT]),
        runCmd('/usr/bin/uptime', []),
        runCmd('/usr/sbin/sysctl', ['-n', 'hw.ncpu']),
    ]);
    const disk = parseDf(dfOut);
    if (!disk) {
        throw new SampleError(`df 输出异常（未检得 ${exports.DATA_VOLUME_MOUNT} 行），无法采样磁盘`);
    }
    const up = parseUptime(upOut);
    const cores = Number(ncpuOut.trim()) || 0;
    return {
        cpu: {
            pct: round2(top.userPct + top.sysPct),
            user: round2(top.userPct),
            sys: round2(top.sysPct),
            load1: up.load1,
            load5: up.load5,
            load15: up.load15,
            cores,
        },
        mem: {
            usedBytes: memUsed,
            totalBytes: memTotal,
            pct: memTotal > 0 ? round2((memUsed / memTotal) * 100) : 0,
            compressBytes: memCompress,
            availBytes: memAvail,
        },
        disk: {
            usedBytes: disk.usedBytes,
            availBytes: disk.availBytes,
            totalBytes: disk.totalBytes,
            pct: round2(disk.pct),
            mount: exports.DATA_VOLUME_MOUNT,
        },
        uptimeSec: up.uptimeSec,
        ts: now(),
    };
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
function readHistory(home = resolveBaigongHome()) {
    let raw;
    try {
        raw = (0, node_fs_1.readFileSync)(historyPath(home), 'utf8');
    }
    catch {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((p) => typeof p === 'object' && p !== null &&
            typeof p.t === 'number' &&
            typeof p.cpuPct === 'number');
    }
    catch {
        return [];
    }
}
/** tmp+rename 原子写（FR-1574 定档；同目录 tmp = 跨设备 rename 必败规避）。 */
function writeHistory(points, home = resolveBaigongHome()) {
    const target = historyPath(home);
    const tmp = `${target}.tmp`;
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(target), { recursive: true });
    (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(points), 'utf8');
    (0, node_fs_1.renameSync)(tmp, target);
}
/** stats → 历史点追加（滚动覆盖 ≤288 点后原子落盘）。 */
function appendSample(stats, home = resolveBaigongHome()) {
    const point = {
        t: stats.ts,
        cpuPct: stats.cpu.pct,
        memPct: stats.mem.pct,
        diskPct: stats.disk.pct,
        diskUsedBytes: stats.disk.usedBytes,
    };
    const points = readHistory(home);
    points.push(point);
    writeHistory(points.slice(-exports.HISTORY_MAX_POINTS), home);
    return point;
}
/**
 * 今日摘要（FR-1576：summary 由点列现算）。
 * 口径 = 今日（本地 0 点起）点列；今日无点时诚实退化用全部点列（避免空 summary）。
 * diskDeltaBytes = 今日最早→最新 diskUsedBytes 差（负值 = 清理了空间，保留符号）。
 */
function computeSummary(points, nowMs = Date.now()) {
    const todayStart = new Date(nowMs);
    todayStart.setHours(0, 0, 0, 0);
    const scoped = points.filter((p) => p.t >= todayStart.getTime());
    const use = scoped.length > 0 ? scoped : points;
    if (use.length === 0) {
        return { cpuAvg: 0, cpuPeak: 0, memAvg: 0, memPeak: 0, diskPctNow: 0, diskDeltaBytes: 0 };
    }
    const avg = (pick) => round2(use.reduce((sum, p) => sum + pick(p), 0) / use.length);
    const peak = (pick) => round2(Math.max(...use.map(pick)));
    const delta = use.length >= 2 ? use[use.length - 1].diskUsedBytes - use[0].diskUsedBytes : 0;
    return {
        cpuAvg: avg((p) => p.cpuPct),
        cpuPeak: peak((p) => p.cpuPct),
        memAvg: avg((p) => p.memPct),
        memPeak: peak((p) => p.memPct),
        diskPctNow: use[use.length - 1].diskPct,
        diskDeltaBytes: delta,
    };
}
