import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemonServer, portFromEnv, intervalSecFromEnv } from '../src/main';
import type { SysStats } from '../src/sample';

/**
 * FR-1575/1576/1578 HTTP 面 jest：/healthz 免鉴权、backend token 门、
 * /stats 注入替身现采、/history 读账本 + summary、端口/间隔 env、
 * 采样定时器注入（fake timers，不真等 300s）。
 */

const TOKEN = 'sys-monitor-test-token';

function fakeRunCmd(map: Record<string, string>) {
  // t_15212ab3：进程榜/详情/kill 全走 argv 全串 key（整机 /usr/bin/top 与进程榜 /usr/bin/top 分流）
  const runCmd = async (cmd: string, args: string[]): Promise<string> => {
    const hit = map[cmd] ?? map[[cmd, ...args].join(' ')];
    if (hit === undefined) throw new Error(`unexpected cmd: ${cmd} ${args.join(' ')}`);
    return hit;
  };
  return { runCmd, calls: [] as string[] };
}

function baseCmdMap(): Record<string, string> {
  return {
    // FR-1574 采样命令钉绝对路径（launchd 子进程 PATH 无 /usr/sbin，裸名 sysctl ENOENT 实证）
    '/usr/bin/top -l 2 -n 0 -s 2': [
      'Processes: 600 total',
      'CPU usage: 18.31% user, 10.21% sys, 71.47% idle',
      'PhysMem: 7169M used (1526M wired, 2604M compressor), 190M unused.',
      '',
      'CPU usage: 6.93% user, 3.88% sys, 89.18% idle',
      'PhysMem: 7180M used (1530M wired, 2610M compressor), 179M unused.',
    ].join('\n'),
    '/usr/sbin/sysctl': '17179869184\n',
    '/bin/df': '/dev/disk3s5 245107203 217495203 24112000 91% /System/Volumes/Data\n',
    '/usr/bin/uptime': ' 14:33  up 11 days,  7:02, 12 users, load averages: 1.71 4.51 8.14',
  };
}

async function withServer<T>(
  options: Parameters<typeof startDaemonServer>[0],
  fn: (base: string, handle: Awaited<ReturnType<typeof startDaemonServer>>) => Promise<T>,
): Promise<T> {
  const handle = await startDaemonServer({ port: 0, ...options });
  try {
    return await fn(`http://127.0.0.1:${handle.port}`, handle);
  } finally {
    await handle.close();
  }
}

let origWanqi: string | undefined;
let home: string;

beforeEach(() => {
  origWanqi = process.env.WANQI_HOME;
  home = mkdtempSync(join(tmpdir(), 'sysmon-http-'));
  process.env.WANQI_HOME = home;
  delete process.env.SYS_MONITOR_INTERVAL_SEC;
  delete process.env.SYS_MONITOR_DAEMON_PORT;
});

afterEach(() => {
  if (origWanqi === undefined) delete process.env.WANQI_HOME;
  else process.env.WANQI_HOME = origWanqi;
  rmSync(home, { recursive: true, force: true });
});

describe('[FR-1575] sys-monitor daemon HTTP 面', () => {
  test('/healthz 200（免鉴权）', async () => {
    await withServer({ backendToken: TOKEN }, async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', service: 'sys-monitor-daemon' });
    });
  });

  test('backend token 执法：缺头/错头 401，对头放行', async () => {
    await withServer({ backendToken: TOKEN, testDeps: { runCmd: fakeRunCmd(baseCmdMap()).runCmd } }, async (base) => {
      const noToken = await fetch(`${base}/stats`);
      expect(noToken.status).toBe(401);
      const badToken = await fetch(`${base}/stats`, { headers: { 'x-baigong-backend-token': 'wrong' } });
      expect(badToken.status).toBe(401);
      const good = await fetch(`${base}/stats`, { headers: { 'x-baigong-backend-token': TOKEN } });
      expect(good.status).toBe(200);
    });
  });

  test('token 缺席配置 = 不设防（开发形态零配置可跑）', async () => {
    await withServer({ testDeps: { runCmd: fakeRunCmd(baseCmdMap()).runCmd } }, async (base) => {
      const res = await fetch(`${base}/stats`);
      expect(res.status).toBe(200);
    });
  });

  test('/stats 现采现回：FR-1575 契约形状逐字段', async () => {
    const now = 1788990000000;
    await withServer({ testDeps: { runCmd: fakeRunCmd(baseCmdMap()).runCmd, now: () => now } }, async (base) => {
      const res = await fetch(`${base}/stats`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SysStats & { ts: number };
      // cpu 面
      expect(body.cpu.user).toBeCloseTo(6.93, 5);
      expect(body.cpu.sys).toBeCloseTo(3.88, 5);
      expect(body.cpu.pct).toBeCloseTo(10.81, 5);
      expect(body.cpu.load1).toBeCloseTo(1.71, 5);
      expect(body.cpu.load5).toBeCloseTo(4.51, 5);
      expect(body.cpu.load15).toBeCloseTo(8.14, 5);
      // mem 面（top PhysMem 主路径）
      expect(body.mem.totalBytes).toBe(17179869184);
      expect(body.mem.usedBytes).toBe(Math.round(7180 * 1024 ** 2));
      expect(body.mem.compressBytes).toBe(Math.round(2610 * 1024 ** 2));
      expect(body.mem.pct).toBeCloseTo((Math.round(7180 * 1024 ** 2) / 17179869184) * 100, 1);
      // disk 面（数据卷）
      expect(body.disk.mount).toBe('/System/Volumes/Data');
      expect(body.disk.usedBytes).toBe(217495203 * 1024);
      // uptime + ts
      expect(body.uptimeSec).toBe(11 * 86400 + 7 * 3600 + 2 * 60);
      expect(body.ts).toBe(now);
    });
  });

  test('/stats 采样命令失败 → 502 {detail}（不 500 不挂）', async () => {
    const badMap = { ...baseCmdMap(), '/usr/bin/top': 'Processes: 1 total\n' }; // 无 CPU usage 行
    await withServer({ testDeps: { runCmd: fakeRunCmd(badMap).runCmd } }, async (base) => {
      const res = await fetch(`${base}/stats`);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { detail: string };
      expect(typeof body.detail).toBe('string');
      expect(body.detail.length).toBeGreaterThan(0);
    });
  });

  test('未知路径 404；POST /stats 404（方法面只开 GET）', async () => {
    await withServer({}, async (base) => {
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/stats`, { method: 'POST' })).status).toBe(404);
    });
  });
});

// ── t_15212ab3：进程榜 /processes + 详情 + 杀进程口子 ──────────────────────

const TOP_PROC_MAP_KEY = '/usr/bin/top -l 2 -o mem -n 20 -s 2 -stats pid,command,cpu,mem';

const TOP_PROC_OUT = [
  'Processes: 512 total',
  'CPU usage: 23.45% user, 55.55% sys, 20.98% idle',
  'PhysMem: 7304M used (1484M wired, 1615M compressor), 367M unused.',
  '',
  'PID    COMMAND      %CPU MEM',
  '34435  node         0.1  689M+',
  '431    WindowServer 0.0  449M',
  '8800   Google Chrome Helper  15.2  986M',
].join('\n');

const PS_COMM_OUT = [
  '    1 /sbin/launchd',
  '  431 /System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer',
  ' 34435 /usr/local/bin/node',
  ' 8800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper',
].join('\n');

const PS_ETIME_OUT = [
  '    1 35:15 /sbin/launchd',
  ' 34435 3:12 /usr/local/bin/node',
].join('\n');

/** 进程榜三命令 + 整机四命令全量假 runCmd（stat 注入共用）。 */
function fullCmdMap(): Record<string, string> {
  return {
    ...baseCmdMap(),
    [TOP_PROC_MAP_KEY]: TOP_PROC_OUT,
    '/bin/ps -axo pid=,comm=': PS_COMM_OUT,
    '/bin/ps -axo pid=,etime=,comm=': PS_ETIME_OUT,
    '/bin/kill -TERM 34435': '',
  };
}

describe('[t_15212ab3] /processes + 详情 + kill 面', () => {
  test('GET /processes：30s 快档并采入缓存，秒回缓存且零新增 spawn（#612 铁律）', async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeRunCmd(fullCmdMap());
      await withServer({ warmup: true, intervalSec: 300, testDeps: { runCmd: fake.runCmd } }, async (base) => {
        await jest.advanceTimersByTimeAsync(0); // 暖拍（整机+进程榜并采）排空
        const res = await fetch(`${base}/processes`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { processes: { pid: number; name: string; cpuPct: number; memBytes: number; protected: boolean }[]; ts: number };
        // 展示前 10、按内存降序、保护标记在
        expect(body.processes.length).toBe(3);
        expect(body.processes[0].pid).toBe(8800); // 986M 最大
        const node = body.processes.find((p) => p.pid === 34435)!;
        expect(node.name).toBe('node');
        expect(node.memBytes).toBe(Math.round(689 * 1024 ** 2));
        expect(node.protected).toBe(false);
        const ws = body.processes.find((p) => p.pid === 431)!;
        expect(ws.protected).toBe(true);
        expect(typeof body.ts).toBe('number');
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('GET /processes 冷窗回落现采；采样失败 502 {detail}（诚实降级不整卡隐藏）', async () => {
    await withServer({ testDeps: { runCmd: fakeRunCmd(fullCmdMap()).runCmd } }, async (base) => {
      const res = await fetch(`${base}/processes`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { processes: unknown[] }).processes.length).toBe(3);
    });
    const badMap = { ...fullCmdMap(), [TOP_PROC_MAP_KEY]: 'Processes: 1 total\n' };
    await withServer({ testDeps: { runCmd: fakeRunCmd(badMap).runCmd } }, async (base) => {
      const res = await fetch(`${base}/processes`);
      expect(res.status).toBe(502);
      expect(typeof ((await res.json()) as { detail: string }).detail).toBe('string');
    });
  });

  test('GET /processes/{pid}：详情现查（etime/路径/占比），pid 不存在 404', async () => {
    await withServer({ testDeps: { runCmd: fakeRunCmd(fullCmdMap()).runCmd } }, async (base) => {
      const res = await fetch(`${base}/processes/34435`);
      expect(res.status).toBe(200);
      const detail = (await res.json()) as { pid: number; name: string; elapsedSec: number; command: string; protected: boolean };
      expect(detail.pid).toBe(34435);
      expect(detail.name).toBe('node');
      expect(detail.elapsedSec).toBe(3 * 60 + 12);
      expect(detail.command).toBe('/usr/local/bin/node');
      expect(detail.protected).toBe(false);

      const gone = await fetch(`${base}/processes/424242`);
      expect(gone.status).toBe(404);
      expect(typeof ((await gone.json()) as { detail: string }).detail).toBe('string');
    });
  });

  test('POST /processes/{pid}/kill：三保险全过 → {ok, pid, name}；门后面全程 token', async () => {
    await withServer({ backendToken: TOKEN, testDeps: { runCmd: fakeRunCmd(fullCmdMap()).runCmd } }, async (base) => {
      const headers = { 'x-baigong-backend-token': TOKEN };
      const denied = await fetch(`${base}/processes/34435/kill`, { method: 'POST' });
      expect(denied.status).toBe(401); // kill 口子同走 token 门

      const res = await fetch(`${base}/processes/34435/kill`, { method: 'POST', headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, pid: 34435, name: 'node' });
    });
  });

  test('POST kill 拒杀面：保护名单 403 / 不在快照 403 / 已退出 404', async () => {
    const map = fullCmdMap();
    delete map['/bin/kill -TERM 34435'];
    await withServer({ testDeps: { runCmd: fakeRunCmd(map).runCmd } }, async (base) => {
      const ws = await fetch(`${base}/processes/431/kill`, { method: 'POST' });
      expect(ws.status).toBe(403); // WindowServer 保护名单
      expect(((await ws.json()) as { detail: string }).detail).toContain('系统关键进程');

      const blind = await fetch(`${base}/processes/424242/kill`, { method: 'POST' });
      expect(blind.status).toBe(403); // 不在最近快照，防盲猜乱杀
      expect(((await blind.json()) as { detail: string }).detail).toContain('占用榜');

      const gone = await fetch(`${base}/processes/999999/kill`, { method: 'POST' });
      expect(gone.status).toBe(403); // 不在快照（快照闸先于存在性闸）
    });
  });

  test('kill 路由匹配单点：/processes/{pid}/kill 精确形态', async () => {
    const { matchKillRoute } = await import('../src/http/router');
    expect(matchKillRoute('POST', '/processes/123/kill')).toBe(123);
    expect(matchKillRoute('GET', '/processes/123/kill')).toBeNull();
    expect(matchKillRoute('POST', '/processes/123')).toBeNull();
    expect(matchKillRoute('POST', '/processes/abc/kill')).toBeNull();
    expect(matchKillRoute('POST', '/processes/123/kill/extra')).toBeNull();
  });
});

describe('[FR-1576] /history 面', () => {
  test('空账本 200 空列 + 零 summary（合法）', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/history`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { points: unknown[]; summary: Record<string, number> };
      expect(body.points).toEqual([]);
      expect(body.summary.cpuAvg).toBe(0);
      expect(body.summary.diskDeltaBytes).toBe(0);
    });
  });

  test('读账本回点列 + summary 现算', async () => {
    const target = join(home, 'data', 'miniapps', 'sys-monitor', 'history.json');
    mkdirSync(join(target, '..'), { recursive: true });
    const points = [
      { t: Date.now() - 600_000, cpuPct: 10, memPct: 50, diskPct: 80, diskUsedBytes: 80 * 1024 ** 3 },
      { t: Date.now() - 300_000, cpuPct: 30, memPct: 70, diskPct: 85, diskUsedBytes: 85 * 1024 ** 3 },
      { t: Date.now(), cpuPct: 20, memPct: 60, diskPct: 90, diskUsedBytes: 90 * 1024 ** 3 },
    ];
    writeFileSync(target, JSON.stringify(points), 'utf8');
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/history`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { points: typeof points; summary: Record<string, number> };
      expect(body.points.length).toBe(3);
      expect(body.points[0].cpuPct).toBe(10);
      expect(body.summary.cpuAvg).toBeCloseTo(20, 5);
      expect(body.summary.cpuPeak).toBeCloseTo(30, 5);
      expect(body.summary.diskPctNow).toBeCloseTo(90, 5);
      expect(body.summary.diskDeltaBytes).toBe(10 * 1024 ** 3);
    });
  });

  test('定时采样（#612 双档）：fake timers 推进 cacheSec 快档 → 账本按 intervalSec 节流落点（零真等待）', async () => {
    jest.useFakeTimers();
    try {
      await withServer({ intervalSec: 300, cacheSec: 1, testDeps: { runCmd: fakeRunCmd(baseCmdMap()).runCmd } }, async (base, handle) => {
        expect(handle.intervalSec).toBe(300);
        expect(handle.cacheSec).toBe(1);
        await jest.advanceTimersByTimeAsync(1100);
        // 让注入的异步采样微任务排空
        await Promise.resolve();
        await Promise.resolve();
        const raw = readFileSync(join(home, 'data', 'miniapps', 'sys-monitor', 'history.json'), 'utf8');
        const points = JSON.parse(raw) as { t: number; cpuPct: number }[];
        expect(points.length).toBe(1);
        expect(points[0].cpuPct).toBeCloseTo(10.81, 5);
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('[FR-1574] env 解析', () => {
  test('portFromEnv：缺省 9207 / env 覆盖 / 坏值落缺省', () => {
    expect(portFromEnv({})).toBe(9207);
    expect(portFromEnv({ SYS_MONITOR_DAEMON_PORT: '9300' })).toBe(9300);
    expect(portFromEnv({ SYS_MONITOR_DAEMON_PORT: 'abc' })).toBe(9207);
    expect(portFromEnv({ SYS_MONITOR_DAEMON_PORT: '70000' })).toBe(9207);
  });
  test('intervalSecFromEnv：缺省 300 / env 覆盖 / 坏值与 ≤0 落缺省 / options 优先', () => {
    expect(intervalSecFromEnv({}, {})).toBe(300);
    expect(intervalSecFromEnv({}, { SYS_MONITOR_INTERVAL_SEC: '60' })).toBe(60);
    expect(intervalSecFromEnv({}, { SYS_MONITOR_INTERVAL_SEC: 'x' })).toBe(300);
    expect(intervalSecFromEnv({}, { SYS_MONITOR_INTERVAL_SEC: '0' })).toBe(300);
    expect(intervalSecFromEnv({ intervalSec: 5 }, { SYS_MONITOR_INTERVAL_SEC: '60' })).toBe(5);
  });
});
