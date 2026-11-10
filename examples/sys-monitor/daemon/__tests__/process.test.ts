import {
  parseTopProcesses,
  parseMemToken,
  parsePsLine,
  parseEtime,
  parsePsCommMap,
  isProtectedProcess,
  collectProcesses,
  collectProcessDetail,
  killProcess,
  KillDeniedError,
  ProcessGoneError,
  PROCESS_SAMPLE_COUNT,
  PROCESS_TOP_SHOWN,
} from '../src/process-sample';
import type { ProcInfo } from '../src/process-sample';
import { SampleError } from '../src/sample';

/**
 * t_15212ab3 进程榜采样层 jest：夹具文本单测（卡内验收闸：禁真 spawn）。
 * 夹具 = 0916 本机 top/ps 一手实测输出形态（含第二拍 MEM 生长标记 `+`、
 * 进程名带空格、ps 全路径）。
 */

// ── 夹具（本机实测形态）───────────────────────────────────────────────────

const TOP_TWO_SHOTS_PROC = `Processes: 512 total, 7 running, 505 sleeping, 2543 threads
2026/09/16 08:52:03
Load Avg: 6.66, 9.87, 14.25
CPU usage: 23.45% user, 55.55% sys, 20.98% idle
SharedLibs: 383M resident, 92M data, 65M linkedit.
PhysMem: 7304M used (1484M wired, 1615M compressor), 367M unused.
VM: 208T vsize, 5363M framework vsize, 4654098(0) swapins, 5132561(0) swapouts.
Networks: packets: 957412/1330M in, 853916/1320M out.
Disks: 11205296/164G read, 3246751/98G written.

PID    COMMAND      %CPU MEM
34435  node         0.0  689M
32360  node         0.0  459M
431    WindowServer 0.0  449M
880    python3.11   0.0  375M
872    watchman     0.0  318M

Processes: 512 total, 9 running, 503 sleeping, 2593 threads
2026/09/16 08:52:05
Load Avg: 6.84, 9.86, 14.22
CPU usage: 19.74% user, 47.29% sys, 32.96% idle
PhysMem: 7290M used (1471M wired, 1614M compressor), 381M unused.

PID    COMMAND      %CPU MEM
34435  node         0.1  689M+
32360  node         0.0  459M
431    WindowServer 0.0  449M
880    python3.11   11.7 375M
872    watchman     0.0  318M
8800   Google Chrome Helper  15.2  986M
8801   Code Helper (Plugin)  31.8  742M
`;

const PS_COMM = `    1 /sbin/launchd
  431 /System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer
    0 kernel_task
  34435 /usr/local/bin/node
999999
`;

const PS_ETIME = `    1 35:15 /sbin/launchd
  431 33:49 /System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer
 8800 11-3:45:12 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper
 8801 45 /usr/local/bin/node
`;

describe('parseMemToken', () => {
  test('K/M/G 单位换算 bytes', () => {
    expect(parseMemToken('512K')).toBe(512 * 1024);
    expect(parseMemToken('689M')).toBe(Math.round(689 * 1024 ** 2));
    expect(parseMemToken('1.2G')).toBe(Math.round(1.2 * 1024 ** 3));
  });
  test('非法 token null', () => {
    expect(parseMemToken('abc')).toBeNull();
    expect(parseMemToken('')).toBeNull();
  });
});

describe('parseTopProcesses（两拍取最后收行的表）', () => {
  test('第二拍表胜出：CPU 值取第二拍、MEM 生长标记 + 被容忍', () => {
    const parsed = parseTopProcesses(TOP_TWO_SHOTS_PROC);
    expect(parsed.hasTable).toBe(true);
    const node = parsed.processes.find((p) => p.pid === 34435)!;
    expect(node.cpuPct).toBeCloseTo(0.1, 5); // 第二拍 0.1（第一拍 0.0）
    expect(node.memBytes).toBe(Math.round(689 * 1024 ** 2)); // 689M+ → bytes
  });
  test('进程名带空格整段吃下（Chrome Helper / 括号名）', () => {
    const parsed = parseTopProcesses(TOP_TWO_SHOTS_PROC);
    const chrome = parsed.processes.find((p) => p.pid === 8800)!;
    expect(chrome.name).toBe('Google Chrome Helper');
    expect(chrome.memBytes).toBe(Math.round(986 * 1024 ** 2));
    const code = parsed.processes.find((p) => p.pid === 8801)!;
    expect(code.name).toBe('Code Helper (Plugin)');
    expect(code.cpuPct).toBeCloseTo(31.8, 5);
  });
  test('结果按内存降序（daemon 排好序 h5 直渲染）', () => {
    const parsed = parseTopProcesses(TOP_TWO_SHOTS_PROC);
    for (let i = 1; i < parsed.processes.length; i++) {
      expect(parsed.processes[i - 1].memBytes).toBeGreaterThanOrEqual(parsed.processes[i].memBytes);
    }
  });
  test('无进程表 → hasTable=false（采集层判失败）', () => {
    expect(parseTopProcesses('Processes: 1 total\n').hasTable).toBe(false);
  });
  test('单拍表同样解析（第二拍语义由采样层 -l 2 保证）', () => {
    const parsed = parseTopProcesses('PID COMMAND %CPU MEM\n1 launchd 0.5 12M\n');
    expect(parsed.hasTable).toBe(true);
    expect(parsed.processes[0].name).toBe('launchd');
  });
});

describe('ps 解析（parsePsLine / parseEtime / parsePsCommMap）', () => {
  test('pid=,etime=,comm= 单行：全路径保留', () => {
    const line = parsePsLine('  431 33:49  /System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer')!;
    expect(line.pid).toBe(431);
    expect(line.elapsedSec).toBe(33 * 60 + 49);
    expect(line.command).toBe('/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer');
  });
  test('etime 形态族：秒 / 分:秒 / 时:分:秒 / 天-时:分:秒', () => {
    expect(parseEtime('45')).toBe(45);
    expect(parseEtime('35:15')).toBe(35 * 60 + 15);
    expect(parseEtime('3:45:12')).toBe(3 * 3600 + 45 * 60 + 12);
    expect(parseEtime('11-3:45:12')).toBe((11 * 24 + 3) * 3600 + 45 * 60 + 12);
    expect(parseEtime('junk')).toBe(0);
  });
  test('parsePsCommMap：pid → 全路径；非 pid 行跳过', () => {
    const map = parsePsCommMap(PS_COMM);
    expect(map.get(1)).toBe('/sbin/launchd');
    expect(map.get(0)).toBe('kernel_task');
    expect(map.get(34435)).toBe('/usr/local/bin/node');
    expect(map.has(999999)).toBe(false); // 纯数字行（无路径）不进表
  });
});

describe('isProtectedProcess（保护名单全路径段前缀）', () => {
  test('pid 0/1 恒保护', () => {
    expect(isProtectedProcess(1, '/sbin/launchd')).toBe(true);
    expect(isProtectedProcess(0, 'kernel_task')).toBe(true);
    expect(isProtectedProcess(1, '/weird/launchd')).toBe(true);
  });
  test('WindowServer 真身路径保护', () => {
    expect(isProtectedProcess(431, '/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer')).toBe(true);
  });
  test('系统目录族保护（/usr/sbin /usr/libexec /CoreServices）', () => {
    expect(isProtectedProcess(100, '/usr/sbin/systemstats')).toBe(true);
    expect(isProtectedProcess(101, '/usr/libexec/configd')).toBe(true);
    expect(isProtectedProcess(102, '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder')).toBe(true);
  });
  test('前缀精确到路径段：/usr/libexecd 不被 /usr/libexec 误吞', () => {
    expect(isProtectedProcess(200, '/usr/libexecd/myproc')).toBe(false);
  });
  test('普通用户进程不保护', () => {
    expect(isProtectedProcess(34435, '/usr/local/bin/node')).toBe(false);
    expect(isProtectedProcess(8800, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper')).toBe(false);
  });
  test('路径未知 = 保守保护', () => {
    expect(isProtectedProcess(300, '')).toBe(true);
  });
});

describe('collectProcesses（注入假 runCmd）', () => {
  function fakeRunCmd(map: Record<string, string>, failPs = false) {
    return async (cmd: string, args: string[]): Promise<string> => {
      if (cmd === '/bin/ps') {
        if (failPs) throw new Error('ps boom');
        return PS_COMM;
      }
      const hit = map[[cmd, ...args].join(' ')];
      if (hit === undefined) throw new Error(`unexpected cmd: ${cmd} ${args.join(' ')}`);
      return hit;
    };
  }
  const topKey = `/usr/bin/top -l 2 -o mem -n ${PROCESS_SAMPLE_COUNT} -s 2 -stats pid,command,cpu,mem`;

  test('top+ps 并采：保护名单标记落进榜条目（WindowServer true / node false）', async () => {
    const payload = await collectProcesses({ runCmd: fakeRunCmd({ [topKey]: TOP_TWO_SHOTS_PROC }), now: () => 1234 });
    expect(payload.ts).toBe(1234);
    const ws = payload.processes.find((p) => p.pid === 431)!;
    expect(ws.protected).toBe(true);
    const node = payload.processes.find((p) => p.pid === 34435)!;
    expect(node.protected).toBe(false);
    expect(node.memBytes).toBe(Math.round(689 * 1024 ** 2));
  });

  test('ps 失败不炸：保护标记退化全 false（kill 时 fresh ps 复核兜底）', async () => {
    const payload = await collectProcesses({ runCmd: fakeRunCmd({ [topKey]: TOP_TWO_SHOTS_PROC }, true) });
    expect(payload.processes.every((p) => !p.protected)).toBe(true);
  });

  test('top 无进程表 → SampleError', async () => {
    await expect(collectProcesses({ runCmd: fakeRunCmd({ [topKey]: 'Processes: 1 total\n' }) })).rejects.toBeInstanceOf(SampleError);
  });
});

describe('collectProcessDetail（详情现查一次）', () => {
  const snapshot: ProcInfo[] = [
    { pid: 8800, name: 'Google Chrome Helper', cpuPct: 15.2, memBytes: 986 * 1024 ** 2, protected: false },
  ];
  function fakeRunCmd(map: Record<string, string>) {
    return async (cmd: string): Promise<string> => {
      const hit = map[cmd];
      if (hit === undefined) throw new Error(`unexpected cmd: ${cmd}`);
      return hit;
    };
  }
  test('命中：快照带 cpu/mem，ps 带 etime+路径，占比现算', async () => {
    const detail = await collectProcessDetail({
      runCmd: fakeRunCmd({ '/bin/ps': PS_ETIME }),
      pid: 8800,
      totalMemBytes: 8 * 1024 ** 3,
      snapshot,
    });
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('Google Chrome Helper');
    expect(detail!.cpuPct).toBeCloseTo(15.2, 5);
    expect(detail!.memBytes).toBe(986 * 1024 ** 2);
    expect(detail!.elapsedSec).toBe((11 * 24 + 3) * 3600 + 45 * 60 + 12);
    expect(detail!.command).toContain('Chrome Helper');
    expect(detail!.protected).toBe(false);
    expect(detail!.memPctOfTotal).toBeCloseTo((986 * 1024 ** 2 / (8 * 1024 ** 3)) * 100, 1);
  });

  test('不在快照：名字回退 ps basename、cpu/mem 如实零值', async () => {
    const detail = await collectProcessDetail({ runCmd: fakeRunCmd({ '/bin/ps': PS_ETIME }), pid: 8801 });
    expect(detail!.name).toBe('node');
    expect(detail!.cpuPct).toBe(0);
    expect(detail!.memBytes).toBe(0);
    expect(detail!.memPctOfTotal).toBeNull();
  });

  test('pid 不存在 → null（404 面）', async () => {
    const detail = await collectProcessDetail({ runCmd: fakeRunCmd({ '/bin/ps': PS_ETIME }), pid: 424242 });
    expect(detail).toBeNull();
  });
  test('ps 失败 → null（详情页「进程已结束」诚实降级）', async () => {
    const detail = await collectProcessDetail({ runCmd: async () => { throw new Error('boom'); }, pid: 8800 });
    expect(detail).toBeNull();
  });
});

describe('killProcess（三保险，注入假 runCmd）', () => {
  const snapshot: ProcInfo[] = [
    { pid: 34435, name: 'node', cpuPct: 0.1, memBytes: 100, protected: false },
    { pid: 431, name: 'WindowServer', cpuPct: 0, memBytes: 200, protected: true },
    { pid: 500, name: 'myproc', cpuPct: 0, memBytes: 300, protected: false },
  ];
  function fakeRunCmd(opts: { psOut?: string; killFail?: { code: string } }) {
    return async (cmd: string, args: string[]): Promise<string> => {
      if (cmd === '/bin/ps') return opts.psOut ?? PS_COMM;
      if (cmd === '/bin/kill') {
        if (opts.killFail) {
          const e = new Error('kill failed') as Error & { code?: string };
          e.code = opts.killFail.code;
          throw e;
        }
        return '';
      }
      throw new Error(`unexpected cmd: ${cmd} ${args.join(' ')}`);
    };
  }

  test('正常杀：SIGTERM 发出，回 {ok, pid, name}', async () => {
    const result = await killProcess(34435, snapshot, { runCmd: fakeRunCmd({}), selfPid: 999 });
    expect(result).toEqual({ ok: true, pid: 34435, name: 'node' });
  });

  test('保护名单（快照标记）→ KillDeniedError', async () => {
    await expect(killProcess(431, snapshot, { runCmd: fakeRunCmd({}) })).rejects.toBeInstanceOf(KillDeniedError);
  });

  test('保护名单（fresh ps 路径命中，快照漏标）→ KillDeniedError（复核兜底）', async () => {
    const psOut = '  500 /usr/sbin/policyd\n';
    await expect(killProcess(500, snapshot, { runCmd: fakeRunCmd({ psOut }) })).rejects.toBeInstanceOf(KillDeniedError);
  });

  test('daemon 自身 pid → KillDeniedError', async () => {
    await expect(killProcess(34435, snapshot, { runCmd: fakeRunCmd({}), selfPid: 34435 })).rejects.toBeInstanceOf(KillDeniedError);
  });

  test('pid 不在最近快照 → KillDeniedError（防盲猜乱杀）', async () => {
    await expect(killProcess(424242, snapshot, { runCmd: fakeRunCmd({}) })).rejects.toBeInstanceOf(KillDeniedError);
  });

  test('pid ≤1 → KillDeniedError', async () => {
    await expect(killProcess(1, snapshot, { runCmd: fakeRunCmd({}) })).rejects.toBeInstanceOf(KillDeniedError);
  });

  test('进程已退出（ps 查无）→ ProcessGoneError（404 面）', async () => {
    const goneSnap: ProcInfo[] = [{ pid: 777, name: 'gone', cpuPct: 0, memBytes: 1, protected: false }];
    await expect(killProcess(777, goneSnap, { runCmd: fakeRunCmd({ psOut: '  1 /sbin/launchd\n' }) })).rejects.toBeInstanceOf(ProcessGoneError);
  });

  test('kill EPERM → SampleError（可操作提示）', async () => {
    await expect(killProcess(34435, snapshot, { runCmd: fakeRunCmd({ killFail: { code: 'EPERM' } }) })).rejects.toThrow('权限不足');
  });

  test('kill ESRCH → SampleError 友好错', async () => {
    await expect(killProcess(34435, snapshot, { runCmd: fakeRunCmd({ killFail: { code: 'ESRCH' } }) })).rejects.toThrow('不存在');
  });

  test('快照标记 protected 但 ps 失败 → 拒杀（不无核实发信号）', async () => {
    const psFail = async (cmd: string): Promise<string> => {
      if (cmd === '/bin/ps') throw new Error('ps boom');
      return '';
    };
    await expect(killProcess(431, snapshot, { runCmd: psFail })).rejects.toBeInstanceOf(KillDeniedError);
  });
});

describe('条数档', () => {
  test('采 20 展示 10（拍板定档）', () => {
    expect(PROCESS_SAMPLE_COUNT).toBe(20);
    expect(PROCESS_TOP_SHOWN).toBe(10);
  });
});
