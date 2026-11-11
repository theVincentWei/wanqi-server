"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROTECTED_PIDS = exports.PROTECTED_PATHS = exports.ProcessGoneError = exports.KillDeniedError = exports.PROCESS_TOP_SHOWN = exports.PROCESS_SAMPLE_COUNT = exports.defaultRunCmd = void 0;
exports.parseTopProcesses = parseTopProcesses;
exports.parseMemToken = parseMemToken;
exports.parsePsLine = parsePsLine;
exports.parseEtime = parseEtime;
exports.basenameOf = basenameOf;
exports.isProtectedProcess = isProtectedProcess;
exports.parsePsCommMap = parsePsCommMap;
exports.collectProcesses = collectProcesses;
exports.collectProcessDetail = collectProcessDetail;
exports.killProcess = killProcess;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
/**
 * sys-monitor 进程榜采样层（t_15212ab3：Top 10 CPU/内存占用 + 远程杀进程）。
 *
 * 与 sample.ts（CPU/内存/磁盘整机三值）分文件：进程榜是独立命令/独立解析/
 * 独立缓存，不进 SysStats 契约（存量 /stats 消费端零扰动）。
 *
 * 判据（0916 本机实测定档）：
 * - 榜单：`top -l 2 -o mem -n 20 -s 2 -stats pid,command,cpu,mem` 单 spawn 双拍——
 *   第二拍才是真窗口值（第二拍 MEM 列实测带生长标记后缀 `449M+`，解析容忍）；
 *   -o mem 按内存序（采 20 展示前 10，余量防进程退出后榜单缩水）。
 *   单拍 %CPU 是自启动累计均值失真——与 FR-1574 整机 CPU「两拍取第二拍」同判据。
 * - 名单面：`/bin/ps -axo pid=,comm=` 并采（全路径），用于**保护名单标记**
 *   （h5 详情页对受保护进程不渲染退出按钮——简图拍板项）。
 * - 详情：ps 现查 etime + 全路径（详情页用户点进来的单次查询，允许现查；
 *   榜单/首页面仍守 #612 缓存秒回铁律）。
 * - kill：`/bin/kill -TERM <pid>`（SIGTERM 给进程收尾机会，卡内定档）。
 *
 * 杀进程三保险（防误杀）：
 *   ① 保护名单（launchd/kernel_task/WindowServer/系统守护族，全路径前缀匹配——
 *      basename 相等会放走同名冒名进程，路径钉死才是真保护）
 *   ② pid 必须出现在最近一次进程榜快照（防盲猜 pid 乱杀）
 *   ③ 拒杀 daemon 自身 pid
 */
const sample_ts_1 = require("./sample.js");
const defaultRunCmd = (cmd, args) => execFileAsync(cmd, args, { timeout: 15_000 }).then((r) => r.stdout);
exports.defaultRunCmd = defaultRunCmd;
/** 进程榜采样条数（采 20 展示前 10——余量防几条进程退出后榜单不足 10）。 */
exports.PROCESS_SAMPLE_COUNT = 20;
/** h5 榜单展示条数（拍板定档：前 10）。 */
exports.PROCESS_TOP_SHOWN = 10;
/** 杀进程被拒（保护名单/自身 pid/快照缺席）——HTTP 403 {detail}。 */
class KillDeniedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'KillDeniedError';
    }
}
exports.KillDeniedError = KillDeniedError;
/** pid 不存在（ESRCH 语义：kill 目标/详情查无此进程）——HTTP 404 {detail}。 */
class ProcessGoneError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProcessGoneError';
    }
}
exports.ProcessGoneError = ProcessGoneError;
/**
 * top -l 2 输出进程表解析：`PID    COMMAND      %CPU MEM` 表头定位，行形
 * `34435  node  0.1  689M`（MEM 带生长标记 `+` 容忍）。进程名含空格
 * （`Google Chrome Helper` 类）靠**右锚定两数值列 + 贪婪中段**吃下。
 * 多拍输出取**最后一次**收到数据行的表（= 第二拍），与 parseTopOutput 同判据。
 * 解析失败的行跳过不炸（脏行容错）。
 */
function parseTopProcesses(text) {
    const out = { processes: [], hasTable: false };
    let current = [];
    let inTable = false;
    let sawRowInTable = false;
    const settle = () => {
        if (inTable && sawRowInTable) {
            out.processes = current;
            out.hasTable = true;
        }
    };
    for (const line of text.split('\n')) {
        if (/^PID\s+COMMAND\b/.test(line)) {
            settle(); // 新表头 = 下一拍开始；上一张表收过行则落定为候选
            current = [];
            inTable = true;
            sawRowInTable = false;
            continue;
        }
        if (!inTable)
            continue;
        const m = /^\s*(\d+)\s+(.+?)\s+(-?[\d.]+)\s+([\d.]+[KMGTP])\+?\s*$/.exec(line);
        if (!m) {
            if (sawRowInTable) {
                settle(); // 表头后的非数据行（空行/下一拍摘要）= 本表结束
                inTable = false;
            }
            continue;
        }
        const memBytes = parseMemToken(m[4]);
        if (memBytes === null)
            continue;
        current.push({ pid: Number(m[1]), name: m[2].trim(), cpuPct: Number(m[3]), memBytes, protected: false });
        sawRowInTable = true;
    }
    settle();
    out.processes.sort((a, b) => b.memBytes - a.memBytes);
    return out;
}
/** top MEM token（689M / 1.2G / 512K）→ bytes；非法 null。 */
function parseMemToken(token) {
    const m = /^([\d.]+)([KMGTP])$/i.exec(token.trim());
    if (!m)
        return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value))
        return null;
    const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
    return Math.round(value * mult[m[2].toUpperCase()]);
}
/** `ps -axo pid=,etime=,comm=` 单行解析：`431  33:49  /System/.../WindowServer`。 */
function parsePsLine(line) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m)
        return null;
    return { pid: Number(m[1]), elapsedSec: parseEtime(m[2]), command: m[3] };
}
/** ps etime 形态族 → 秒（POSIX 定档：[[dd-]hh:]mm:ss——冒号两段必是 分:秒）。 */
function parseEtime(token) {
    const t = token.trim();
    const dm = /^(\d+)-(.+)$/.exec(t);
    let body = t;
    let days = 0;
    if (dm) {
        days = Number(dm[1]);
        body = dm[2];
    }
    const parts = body.split(':').map((p) => Number(p));
    if (parts.some((p) => !Number.isFinite(p)))
        return 0;
    if (parts.length === 3)
        return (days * 24 + parts[0]) * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2)
        return days * 86400 + parts[0] * 60 + parts[1];
    if (parts.length === 1 && parts[0] >= 0)
        return days * 86400 + parts[0];
    return 0;
}
/** basename（无依赖实现；进程名兜底单点）。 */
function basenameOf(p) {
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
}
// ── 保护名单（防误杀三保险之一）───────────────────────────────────────────
/**
 * 受保护路径/名（kill 口子 403 + 详情页不渲染退出按钮双面生效）。
 * 判据 = ps comm **全路径段前缀匹配**（防同名冒名）+ pid 面特判。
 */
exports.PROTECTED_PATHS = [
    '/sbin/launchd',
    '/mach_kernel',
    'kernel_task', // ps comm 对 pid 0 直接给此名（非路径）
    '/System/Library/PrivateFrameworks', // WindowServer（SkyLight）+ 系统私有框架族守护
    '/System/Library/CoreServices',
    '/usr/libexec',
    '/usr/sbin',
    '/usr/lib/system',
    '/System/Library/ExtensionKit',
];
/** pid 0（kernel_task）/1（launchd）恒保护，无论路径形态。 */
exports.PROTECTED_PIDS = [0, 1];
/**
 * 保护名单判定（纯函数单测面）。comm 前缀精确到路径段
 * （'/usr/libexec' 不误吞 '/usr/libexecd'）。
 */
function isProtectedProcess(pid, command) {
    if (exports.PROTECTED_PIDS.includes(pid))
        return true;
    const comm = command.trim();
    if (comm === '')
        return true; // 路径未知 = 不给杀（诚实保守）
    return exports.PROTECTED_PATHS.some((p) => comm === p || comm.startsWith(`${p}/`));
}
/** `ps -axo pid=,comm=` 整表 → {pid → 全路径}（保护标记/kill 复核共用）。 */
function parsePsCommMap(psOut) {
    const map = new Map();
    for (const line of psOut.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (m)
            map.set(Number(m[1]), m[2]);
    }
    return map;
}
/**
 * 进程榜现采（30s 快档数据源）：top 双拍 + ps 名单面并行（两 spawn/拍，
 * 外层 sampling 旗标防叠加）。top 失败 = SampleError 整拍失败；ps 失败
 * 不炸（保护标记退化全 false，kill 时 fresh ps 复核兜底）。
 */
async function collectProcesses(deps = {}) {
    const runCmd = deps.runCmd ?? exports.defaultRunCmd;
    const now = deps.now ?? Date.now;
    const topArgs = [
        '-l', '2',
        '-o', 'mem',
        '-n', String(exports.PROCESS_SAMPLE_COUNT),
        '-s', '2',
        '-stats', 'pid,command,cpu,mem',
    ];
    const [topOut, psCommOut] = await Promise.all([
        runCmd('/usr/bin/top', topArgs),
        runCmd('/bin/ps', ['-axo', 'pid=,comm=']).catch(() => ''),
    ]);
    const parsed = parseTopProcesses(topOut);
    if (!parsed.hasTable) {
        throw new sample_ts_1.SampleError('top 输出异常（未检得进程表），无法采样进程榜');
    }
    const commMap = parsePsCommMap(psCommOut);
    // 名单面缺席（ps 失败）→ 标记退化 false：kill 口子另有 fresh ps 复核兜底，榜面不为它说谎
    const processes = parsed.processes.map((p) => {
        const comm = commMap.get(p.pid);
        return { ...p, protected: comm !== undefined && isProtectedProcess(p.pid, comm) };
    });
    processes.sort((a, b) => b.memBytes - a.memBytes);
    return { processes, ts: now() };
}
/**
 * 详情现查（详情页进页一次）：ps etime + 全路径；cpu/mem 用最近快照值。
 * @returns null = pid 不存在（ESRCH 语义，HTTP 404 面）。
 */
async function collectProcessDetail(deps) {
    const runCmd = deps.runCmd ?? exports.defaultRunCmd;
    const now = deps.now ?? Date.now;
    let psOut;
    try {
        psOut = await runCmd('/bin/ps', ['-axo', 'pid=,etime=,comm=']);
    }
    catch {
        return null; // ps 失败按查无此进程处理（详情页「进程已结束」诚实降级）
    }
    for (const line of psOut.split('\n')) {
        const parsed = parsePsLine(line);
        if (parsed === null || parsed.pid !== deps.pid)
            continue;
        const snap = deps.snapshot?.find((p) => p.pid === deps.pid) ?? null;
        return {
            pid: parsed.pid,
            name: snap ? snap.name : basenameOf(parsed.command),
            cpuPct: snap ? snap.cpuPct : 0,
            memBytes: snap ? snap.memBytes : 0,
            memPctOfTotal: deps.totalMemBytes !== undefined && deps.totalMemBytes > 0 && snap !== null
                ? Math.round((snap.memBytes / deps.totalMemBytes) * 1000) / 10
                : null,
            elapsedSec: parsed.elapsedSec,
            command: parsed.command,
            protected: isProtectedProcess(parsed.pid, parsed.command),
            ts: now(),
        };
    }
    return null;
}
/**
 * 杀进程（SIGTERM）：三保险过闸 → fresh ps 复核保护名单/存在性 → 发信号。
 * @throws KillDeniedError 非法 pid / daemon 自身 / 不在快照 / 保护名单（403 面）
 * @throws ProcessGoneError 进程已不存在（404 面，ESRCH 友好错）
 * @throws SampleError kill 命令其它失败（EPERM 等转 502 面）
 */
async function killProcess(pid, snapshot, deps = {}) {
    if (!Number.isInteger(pid) || pid <= 1) {
        throw new KillDeniedError('非法 pid（≤1 恒拒杀）');
    }
    if (deps.selfPid !== undefined && pid === deps.selfPid) {
        throw new KillDeniedError('该进程是监控服务自身，拒绝退出');
    }
    const hit = snapshot.find((p) => p.pid === pid);
    if (hit === undefined) {
        throw new KillDeniedError('该进程不在最近的占用榜里，为防误杀未执行');
    }
    const runCmd = deps.runCmd ?? exports.defaultRunCmd;
    // 快照已标记保护 → 直接拒（不查 ps，不发信号）
    if (hit.protected) {
        throw new KillDeniedError('系统关键进程，禁止退出');
    }
    let psOut;
    try {
        psOut = await runCmd('/bin/ps', ['-axo', 'pid=,comm=']);
    }
    catch {
        throw new sample_ts_1.SampleError('无法核实进程状态，未执行退出');
    }
    const comm = parsePsCommMap(psOut).get(pid);
    if (comm === undefined) {
        throw new ProcessGoneError('进程不存在或已退出');
    }
    // fresh ps 复核：快照漏标（如 ps 名单面那次缺席）也拦下
    if (isProtectedProcess(pid, comm)) {
        throw new KillDeniedError('系统关键进程，禁止退出');
    }
    try {
        await runCmd('/bin/kill', ['-TERM', String(pid)]);
    }
    catch (error) {
        throw new sample_ts_1.SampleError(killFailDetail(error));
    }
    return { ok: true, pid, name: hit.name };
}
function killFailDetail(error) {
    const err = error;
    if (err?.code === 'ESRCH')
        return '进程不存在或已退出';
    if (err?.code === 'EPERM')
        return '权限不足，无法退出该进程（可在 Mac 上用管理员权限处理）';
    return err?.message ?? 'kill 命令执行失败';
}
