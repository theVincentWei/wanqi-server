import {
  parseMemSizeToken,
  parseTopOutput,
  parseVmStat,
  memFromVmStat,
  parseDf,
  parseUptime,
  parseUptimeBody,
  readHistory,
  writeHistory,
  appendSample,
  computeSummary,
  SampleError,
} from '../src/sample';
import type { SysStats, HistoryPoint } from '../src/sample';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * FR-1574 采样解析层 jest：夹具文本单测（卡内验收闸 ②：禁在单测里真 spawn
 * 系统命令——top/vm_stat/df/uptime 一手实测样例做夹具）。
 */

// ── 夹具（macOS 一手实测形态；来源 = 本机命令输出节选）────────────────────

const TOP_TWO_SHOTS = `Processes: 628 total, 3 running, 625 sleeping, 2475 threads
Load Avg: 1.71, 4.51, 8.14
CPU usage: 18.31% user, 10.21% sys, 71.47% idle
SharedLibs: 599M resident, 118M data, 30M linkedit.
PhysMem: 7169M used (1526M wired, 2604M compressor), 190M unused.
VM: 262T vsize, 3365M framework vsize, 135410882(0) swapins, 148548967(0) swapouts.
Networks: packets: 9842500778/8923M in, 7417460891/7938M out.
Disks: Data 1233810/10243937 read, 771108/9454323 written.

Processes: 628 total, 2 running, 626 sleeping, 2475 threads
Load Avg: 1.69, 4.50, 8.13
CPU usage: 6.93% user, 3.88% sys, 89.18% idle
SharedLibs: 599M resident, 118M data, 30M linkedit.
PhysMem: 7180M used (1530M wired, 2610M compressor), 179M unused.
VM: 262T vsize, 3365M framework vsize, 135410882(0) swapins, 148548967(0) swapouts.
Disks: Data 1233810/10243937 read, 771108/9454323 written.
`;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Free pages:        12345
Pages active:      98765
Pages inactive:    23456
Pages speculative: 1111
Pages wired down:  99000
Pages purgeable:   2222
Pages stored in compressor: 54321
`;

const DF_K = `Filesystem      1024-blocks      Used Available Capacity   Mounted on
/dev/disk3s5    245107203 217495203 24112000    91%    /
/dev/disk3s5    245107203 217495203 24112000    91%    /System/Volumes/Data
`;

const UPTIME = ' 14:33  up 11 days,  7:02, 12 users, load averages: 1.71 4.51 8.14';

describe('[FR-1574] parseMemSizeToken', () => {
  test('K/M/G/T/P 单位换算 bytes', () => {
    expect(parseMemSizeToken('512K')).toBe(512 * 1024);
    expect(parseMemSizeToken('7169M')).toBe(Math.round(7169 * 1024 ** 2));
    expect(parseMemSizeToken('2.5G')).toBe(Math.round(2.5 * 1024 ** 3));
    expect(parseMemSizeToken('1T')).toBe(1024 ** 4);
  });
  test('非法 token 返回 null', () => {
    expect(parseMemSizeToken('abc')).toBeNull();
    expect(parseMemSizeToken('')).toBeNull();
    expect(parseMemSizeToken('12')).toBeNull();
  });
});

describe('[FR-1574] parseTopOutput（两拍取第二拍）', () => {
  test('CPU/PhysMem 取最后一次出现（第二拍真窗口值）', () => {
    const top = parseTopOutput(TOP_TWO_SHOTS);
    expect(top.hasCpuLine).toBe(true);
    expect(top.userPct).toBeCloseTo(6.93, 5);
    expect(top.sysPct).toBeCloseTo(3.88, 5);
    expect(top.idlePct).toBeCloseTo(89.18, 5);
    expect(top.hasPhysMemLine).toBe(true);
    expect(top.memUsedBytes).toBe(Math.round(7180 * 1024 ** 2));
    expect(top.memUnusedBytes).toBe(Math.round(179 * 1024 ** 2));
    expect(top.memWiredBytes).toBe(Math.round(1530 * 1024 ** 2));
    expect(top.memCompressBytes).toBe(Math.round(2610 * 1024 ** 2));
  });
  test('缺 CPU usage 行 → hasCpuLine=false（采集层判失败）', () => {
    const top = parseTopOutput('Processes: 628 total\nPhysMem: 7169M used (1526M wired, 2604M compressor), 190M unused.');
    expect(top.hasCpuLine).toBe(false);
    expect(top.hasPhysMemLine).toBe(true);
  });
  test('单拍输出同样解析（主判第二拍语义由 collectStats 用 -l 2 保证）', () => {
    const top = parseTopOutput('CPU usage: 1.00% user, 2.00% sys, 97.00% idle');
    expect(top.userPct).toBeCloseTo(1, 5);
  });
});

describe('[FR-1574] vm_stat 回退路径', () => {
  test('页行解析 + 页大小读自首行', () => {
    const vm = parseVmStat(VM_STAT);
    expect(vm.pageSize).toBe(16384);
    expect(vm.freePages).toBe(12345);
    expect(vm.compressorPages).toBe(54321);
    expect(vm.purgeablePages).toBe(2222);
  });
  test('memFromVmStat：avail = free+speculative+purgeable，used = total-avail', () => {
    const vm = parseVmStat(VM_STAT);
    const total = 16 * 1024 ** 3;
    const calc = memFromVmStat(vm, total);
    const avail = (12345 + 1111 + 2222) * 16384;
    expect(calc.availBytes).toBe(avail);
    expect(calc.compressBytes).toBe(54321 * 16384);
    expect(calc.usedBytes).toBe(total - avail);
  });
  test('页大小行缺席按 16384 缺省', () => {
    const vm = parseVmStat('Free pages: 100\n');
    expect(vm.pageSize).toBe(16384);
  });
});

describe('[FR-1574] parseDf（数据卷）', () => {
  test('按 mount 定位 /System/Volumes/Data 行（非根卷）', () => {
    const df = parseDf(DF_K);
    expect(df).not.toBeNull();
    expect(df!.usedBytes).toBe(217495203 * 1024);
    expect(df!.availBytes).toBe(24112000 * 1024);
    expect(df!.totalBytes).toBe((217495203 + 24112000) * 1024);
    expect(df!.pct).toBeCloseTo((217495203 / (217495203 + 24112000)) * 100, 5);
  });
  test('mount 缺席 → null（采集层判失败）', () => {
    expect(parseDf('Filesystem  1024-blocks  Used Available Capacity Mounted on\n')).toBeNull();
  });
});

describe('[FR-1574] parseUptime', () => {
  test('load 三值 + up 段时长', () => {
    const up = parseUptime(UPTIME);
    expect(up.load1).toBeCloseTo(1.71, 5);
    expect(up.load5).toBeCloseTo(4.51, 5);
    expect(up.load15).toBeCloseTo(8.14, 5);
    expect(up.uptimeSec).toBe(11 * 86400 + 7 * 3600 + 2 * 60);
  });
  test('up 段形态族', () => {
    expect(parseUptimeBody('3:45')).toBe(3 * 3600 + 45 * 60);
    expect(parseUptimeBody('7:02:30')).toBe(7 * 3600 + 2 * 60 + 30);
    expect(parseUptimeBody('2 mins')).toBe(120);
    expect(parseUptimeBody('1 day, 3:45:12')).toBe(86400 + 3 * 3600 + 45 * 60 + 12);
    expect(parseUptimeBody('5 secs')).toBe(5);
  });
  test('不合预期输出零值不崩', () => {
    expect(parseUptime('weird output').load1).toBe(0);
    expect(parseUptime('weird output').uptimeSec).toBe(0);
  });
});

// ── 采集层：deps 注入（假命令出口，零真 spawn）────────────────────────────

describe('[FR-1574] collectStats（注入假 runCmd）', () => {
  function fakeRunCmd(outputs: Record<string, string>) {
    return async (cmd: string, args: string[]): Promise<string> => {
      const hit = outputs[[cmd, ...args].join(' ')];
      if (hit === undefined) throw new Error(`unexpected cmd: ${cmd} ${args.join(' ')}`);
      return hit;
    };
  }
  const baseOutputs = () => ({
    // FR-1574 采样命令钉绝对路径（launchd 子进程 PATH 无 /usr/sbin 实证修正）
    '/usr/bin/top -l 2 -n 0 -s 2': TOP_TWO_SHOTS,
    '/usr/sbin/sysctl -n hw.memsize': '17179869184\n',
    '/usr/sbin/sysctl -n hw.ncpu': '8\n',
    '/bin/df -k /System/Volumes/Data': DF_K,
    '/usr/bin/uptime': UPTIME,
  });

  test('top 主路径：CPU=两拍第二拍，内存走 PhysMem', async () => {
    const stats = await import('../src/sample').then((m) =>
      m.collectStats({ runCmd: fakeRunCmd(baseOutputs()) }),
    );
    expect(stats.cpu.user).toBeCloseTo(6.93, 5);
    expect(stats.cpu.sys).toBeCloseTo(3.88, 5);
    expect(stats.cpu.pct).toBeCloseTo(10.81, 5);
    expect(stats.cpu.load1).toBeCloseTo(1.71, 5);
    expect(stats.cpu.cores).toBe(8);
    expect(stats.mem.totalBytes).toBe(17179869184);
    expect(stats.mem.usedBytes).toBe(Math.round(7180 * 1024 ** 2));
    expect(stats.mem.compressBytes).toBe(Math.round(2610 * 1024 ** 2));
    expect(stats.disk.mount).toBe('/System/Volumes/Data');
    expect(stats.uptimeSec).toBe(11 * 86400 + 7 * 3600 + 2 * 60);
  });

  test('PhysMem 缺席 → vm_stat 回退路径', async () => {
    const topOnlyCpu = TOP_TWO_SHOTS.replace(/^PhysMem:.*\n/gm, '');
    const outputs = {
      '/usr/bin/top -l 2 -n 0 -s 2': topOnlyCpu,
      '/usr/sbin/sysctl -n hw.memsize': '17179869184\n',
      '/usr/sbin/sysctl -n hw.ncpu': '8\n',
      '/usr/bin/vm_stat': VM_STAT,
      '/bin/df -k /System/Volumes/Data': DF_K,
      '/usr/bin/uptime': UPTIME,
    };
    const stats = await import('../src/sample').then((m) =>
      m.collectStats({ runCmd: fakeRunCmd(outputs) }),
    );
    // 16GB 内存，PhysMem 缺席 → vm_stat 计算
    expect(stats.mem.usedBytes).toBe(17179869184 - (12345 + 1111 + 2222) * 16384);
    expect(stats.mem.compressBytes).toBe(54321 * 16384);
  });

  test('top 缺 CPU usage 行 → SampleError（502 面）', async () => {
    const outputs = { ...baseOutputs(), '/usr/bin/top -l 2 -n 0 -s 2': 'Processes: 1 total\n' };
    await expect(
      import('../src/sample').then((m) => m.collectStats({ runCmd: fakeRunCmd(outputs) })),
    ).rejects.toBeInstanceOf(SampleError);
  });

  test('df 缺数据卷行 → SampleError', async () => {
    const outputs = {
      ...baseOutputs(),
      '/bin/df -k /System/Volumes/Data': 'Filesystem  1024-blocks  Used Available Capacity Mounted on\n',
    };
    await expect(
      import('../src/sample').then((m) => m.collectStats({ runCmd: fakeRunCmd(outputs) })),
    ).rejects.toBeInstanceOf(SampleError);
  });
});

// ── 历史账本：滚动 / 原子写 / summary 现算 ─────────────────────────────────

describe('[FR-1574/1576] history 账本', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sysmon-hist-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const point = (t: number, cpuPct = 10, memPct = 50, diskPct = 88): HistoryPoint => ({
    t, cpuPct, memPct, diskPct, diskUsedBytes: diskPct * 1024 ** 3,
  });

  test('空账本读出空列（合法）', () => {
    expect(readHistory(home)).toEqual([]);
  });
  test('损坏 JSON 读出空列不崩', () => {
    writeFileSync(join(home, 'history.json'), '{not json', 'utf8');
    expect(readHistory(home)).toEqual([]);
  });
  test('append + 滚动 ≤288 点 + 原子写（无 tmp 残留）', () => {
    const stats = (t: number): SysStats => ({
      cpu: { pct: 10, user: 5, sys: 5, load1: 1, load5: 1, load15: 1, cores: 8 },
      mem: { usedBytes: 1, totalBytes: 2, pct: 50, compressBytes: 0, availBytes: 1 },
      disk: { usedBytes: 100, availBytes: 10, totalBytes: 110, pct: 90, mount: '/System/Volumes/Data' },
      uptimeSec: 100,
      ts: t,
    });
    for (let i = 0; i < 290; i += 1) {
      appendSample(stats(i * 1000), home);
    }
    const points = readHistory(home);
    expect(points.length).toBe(288);
    expect(points[0].t).toBe((290 - 288) * 1000); // 老点被滚动覆盖
    expect(points[287].t).toBe(289 * 1000);
    const file = join(home, 'data', 'miniapps', 'sys-monitor', 'history.json');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // 落盘形状 = 点列数组直存
    const raw = JSON.parse(readFileSync(file, 'utf8')) as HistoryPoint[];
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBe(288);
  });

  test('summary 现算：今日窗口 avg/peak + diskDelta', () => {
    const now = new Date('2026-09-10T15:00:00');
    const nowMs = now.getTime();
    const today = (h: number): number =>
      new Date(2026, 8, 10, h).getTime(); // 本地时区今日
    const yesterday = new Date(2026, 8, 9, 23).getTime();
    const points = [
      point(yesterday, 99, 99, 10),            // 昨日点——今日窗口应剔除
      point(today(8), 10, 50, 80),
      point(today(12), 30, 70, 85),
      point(today(14), 20, 60, 90),
    ];
    const summary = computeSummary(points, nowMs);
    expect(summary.cpuAvg).toBeCloseTo(20, 5);
    expect(summary.cpuPeak).toBeCloseTo(30, 5);
    expect(summary.memAvg).toBeCloseTo(60, 5);
    expect(summary.memPeak).toBeCloseTo(70, 5);
    expect(summary.diskPctNow).toBeCloseTo(90, 5);
    // delta = 最新 90*1GB - 最早 80*1GB（同日窗口内）
    expect(summary.diskDeltaBytes).toBe(10 * 1024 ** 3);
  });

  test('今日无点 → 全列退化（不空转）', () => {
    const points = [point(1000, 10, 50, 80), point(2000, 30, 70, 85)];
    const summary = computeSummary(points, 99999999999999);
    expect(summary.cpuAvg).toBeCloseTo(20, 5);
    expect(summary.diskDeltaBytes).toBe(5 * 1024 ** 3);
  });

  test('空点列 → 零 summary（合法空态）', () => {
    const summary = computeSummary([]);
    expect(summary.cpuAvg).toBe(0);
    expect(summary.diskDeltaBytes).toBe(0);
  });
});
