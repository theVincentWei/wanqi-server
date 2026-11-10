import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemonServer, cacheSecFromEnv } from '../src/main';
import type { SysStats } from '../src/sample';

/**
 * #612 预采样缓存面 jest：/stats 秒回缓存（缓存命中零 spawn）、冷窗回落现采、
 * 账本落账节流（快档 30s 一拍 ≠ 每拍落账）、cacheSec env 解析。
 * 全程 fake timers + 注入 runCmd spy（禁真 spawn，卡内验收闸）。
 */

const TOKEN = 'sys-monitor-cache-test-token';

function fakeRunCmd(map: Record<string, string>) {
  const calls: string[] = [];
  // t_15212ab3：进程榜与整机采样同为 /usr/bin/top（argv 不同）——calls 记全命令串供分流断言
  const runCmd = async (cmd: string, args: string[]): Promise<string> => {
    const full = [cmd, ...args].join(' ');
    calls.push(full);
    const hit = map[cmd] ?? map[full];
    if (hit === undefined) throw new Error(`unexpected cmd: ${full}`);
    return hit;
  };
  return { runCmd, calls };
}

function baseCmdMap(): Record<string, string> {
  return {
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
  fn: (base: string, handle: Awaited<ReturnType<typeof startDaemonServer>>, calls: string[]) => Promise<T>,
): Promise<T> {
  const fake = fakeRunCmd(baseCmdMap());
  const handle = await startDaemonServer({ port: 0, testDeps: { runCmd: fake.runCmd }, ...options });
  try {
    return await fn(`http://127.0.0.1:${handle.port}`, handle, fake.calls);
  } finally {
    await handle.close();
  }
}

let origWanqi: string | undefined;
let home: string;

beforeEach(() => {
  origWanqi = process.env.WANQI_HOME;
  home = mkdtempSync(join(tmpdir(), 'sysmon-cache-'));
  process.env.WANQI_HOME = home;
  delete process.env.SYS_MONITOR_INTERVAL_SEC;
  delete process.env.SYS_MONITOR_CACHE_SEC;
  delete process.env.SYS_MONITOR_DAEMON_PORT;
});

afterEach(() => {
  if (origWanqi === undefined) delete process.env.WANQI_HOME;
  else process.env.WANQI_HOME = origWanqi;
  rmSync(home, { recursive: true, force: true });
});

const historyPoints = (): { t: number; cpuPct: number }[] => {
  try {
    return JSON.parse(readFileSync(join(home, 'data', 'miniapps', 'sys-monitor', 'history.json'), 'utf8'));
  } catch {
    return [];
  }
};

describe('[#612] /stats 预采样缓存面', () => {
  test('缓存命中：warmup 暖拍后 /stats 秒回缓存，后续请求零 spawn', async () => {
    jest.useFakeTimers();
    try {
      await withServer({ backendToken: TOKEN, warmup: true, intervalSec: 300 }, async (base, handle, calls) => {
        expect(handle.cacheSec).toBe(30);
        // 让暖拍微任务（collectStats 全链 Promise.all）排空
        await jest.advanceTimersByTimeAsync(0);
        expect(calls.filter((c) => c.startsWith('/usr/bin/top -l 2 -n 0')).length).toBe(1); // 整机采样（进程榜 -o mem 分流不计）

        // 三连发：全部走缓存，零新增 spawn
        for (let i = 0; i < 3; i++) {
          const res = await fetch(`${base}/stats`, { headers: { 'x-baigong-backend-token': TOKEN } });
          expect(res.status).toBe(200);
          const body = (await res.json()) as SysStats;
          // 第二拍真窗口值（缓存的是暖拍采的完整 SysStats）
          expect(body.cpu.pct).toBeCloseTo(10.81, 5);
        }
        expect(calls.filter((c) => c.startsWith('/usr/bin/top -l 2 -n 0')).length).toBe(1); // 整机采样（进程榜 -o mem 分流不计）
      });
    } finally {
      jest.useRealTimers();
    }
  }, 20000);

  test('缓存推进：快档 30s 一拍刷新缓存（fake timers），账本按 intervalSec 节流不逐拍落', async () => {
    jest.useFakeTimers();
    try {
      await withServer({ warmup: true, intervalSec: 300, cacheSec: 30 }, async (base, handle, calls) => {
        expect(handle.intervalSec).toBe(300);
        await jest.advanceTimersByTimeAsync(0); // 暖拍排空
        expect(historyPoints().length).toBe(1); // 暖拍即首笔落账

        // 推进 3 个快档（90s）：缓存刷新 3 次，账本因 300s 未到零新增
        for (let i = 0; i < 3; i++) {
          await jest.advanceTimersByTimeAsync(30_000);
        }
        const tops = calls.filter((c) => c.startsWith('/usr/bin/top -l 2 -n 0')).length;
        expect(tops).toBe(4); // 暖拍 1 + 快档 3（整机采样；进程榜 -o mem 分流不计）
        expect(historyPoints().length).toBe(1); // 节流：未到 300s 不落账

        // 推进到 300s 界：下一拍落第二笔
        await jest.advanceTimersByTimeAsync(220_000);
        expect(historyPoints().length).toBe(2);
      });
    } finally {
      jest.useRealTimers();
    }
  }, 20000);

  test('冷窗回落：无 warmup 且首拍未到 → /stats 回落现采（v1 行为，回数正常）', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/stats`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SysStats;
      expect(body.cpu.pct).toBeCloseTo(10.81, 5);
    });
  });

  test('statsCache 未注入 = v1 行为（现采），RouterOptions 向后兼容', async () => {
    // 该用例由「冷窗回落」间接覆盖（withServer 恒注入 statsCache；此处补显式断言：
    // 不传 warmup 时 handle 正常起、请求现采回 200）
    await withServer({ warmup: false }, async (base) => {
      const res = await fetch(`${base}/stats`);
      expect(res.status).toBe(200);
    });
  });

  test('cacheSecFromEnv：缺省 30 / env 覆盖 / 坏值与 ≤0 落缺省 / options 优先', () => {
    expect(cacheSecFromEnv({}, {})).toBe(30);
    expect(cacheSecFromEnv({}, { SYS_MONITOR_CACHE_SEC: '10' })).toBe(10);
    expect(cacheSecFromEnv({}, { SYS_MONITOR_CACHE_SEC: 'x' })).toBe(30);
    expect(cacheSecFromEnv({}, { SYS_MONITOR_CACHE_SEC: '0' })).toBe(30);
    expect(cacheSecFromEnv({ cacheSec: 5 }, { SYS_MONITOR_CACHE_SEC: '10' })).toBe(5);
  });

  test('warmup 采样失败：缓存不填、不崩；/stats 冷窗回落现采自愈', async () => {
    jest.useFakeTimers();
    try {
      const badMap = { ...baseCmdMap(), '/usr/bin/top': 'Processes: 1 total\n' }; // 无 CPU usage 行
      const fake = fakeRunCmd(badMap);
      const handle = await startDaemonServer({
        port: 0,
        warmup: true,
        testDeps: { runCmd: fake.runCmd },
      });
      try {
        await jest.advanceTimersByTimeAsync(0); // 暖拍失败排空
        const res = await fetch(`http://127.0.0.1:${handle.port}/stats`);
        // 回落现采同样失败 → 502 {detail}（v1 语义保持）
        expect(res.status).toBe(502);
      } finally {
        await handle.close();
      }
    } finally {
      jest.useRealTimers();
    }
  }, 20000);
});
