/**
 * Demo data for the public /demo route.
 * Generates realistic-looking machine data for product screenshots and marketing.
 */

import type {
  Machine,
  Process,
  HardwareProfile,
  CpuProfile,
  DiskProfile,
  GpuProfile,
  NicProfile,
  CpuMetric,
  MemoryMetric,
  DiskMetric,
  GpuMetric,
  NicMetric,
  PrimaryDevices,
  DeviceEntry,
} from '@/hooks/useFirestore';
import type { SparklineDataPoint } from '@/components/charts';
import type { ChartDataPoint } from '@/hooks/useHistoricalMetrics';
import type { TimeRange } from '@/components/charts/TimeRangeSelector';

// ── Helpers ──────────────────────────────────────────────────────────

/** Seeded pseudo-random number generator for deterministic data */
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Generate a smooth sine-wave based value with noise */
function generateMetricValue(
  rand: () => number,
  base: number,
  amplitude: number,
  t: number,
  periodHours: number = 24,
): number {
  const sine = Math.sin((2 * Math.PI * t) / (periodHours * 3600));
  const noise = (rand() - 0.5) * amplitude * 0.4;
  return Math.max(0, Math.min(100, base + sine * amplitude + noise));
}

// ── Constants ────────────────────────────────────────────────────────

export const DEMO_SITE_ID = 'demo-site';

export const DEMO_SITE = {
  id: DEMO_SITE_ID,
  name: 'Horizon Museum of Science',
  createdAt: Date.now() - 90 * 24 * 3600 * 1000,
  timezone: 'America/Los_Angeles',
};

// ── Machine definitions ──────────────────────────────────────────────

interface MachineDef {
  id: string;
  online: boolean;
  rebooting?: boolean;
  rebootPending?: Machine['rebootPending'];
  cpuName: string;
  cpuBase: number;
  memBase: number;
  memTotal: number;
  diskBase: number;
  diskTotal: number;
  gpu?: { name: string; usageBase: number; vramTotal: number; vramUsed: number };
  network?: { latencyMs: number; packetLoss: number; txBps: number; rxBps: number; txUtil: number; rxUtil: number; linkSpeed: number };
  processes: Omit<Process, 'responsive' | 'last_updated' | 'index' | 'priority' | 'visibility' | 'time_delay' | 'time_to_init' | 'relaunch_attempts' | 'cwd'>[];
  agentVersion: string;
}

const machineDefs: MachineDef[] = [
  {
    id: 'lobby-east-01',
    online: true,
    cpuName: 'Intel Core i7-12700K',
    cpuBase: 32, memBase: 58, memTotal: 64, diskBase: 45, diskTotal: 2000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 65, vramTotal: 12, vramUsed: 8.4 },
    network: { latencyMs: 8, packetLoss: 0, txBps: 2500000, rxBps: 15000000, txUtil: 12, rxUtil: 28, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 5234, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/lobby-east.toe' },
      { id: 'p2', name: 'Chrome', status: 'RUNNING', pid: 8291, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://signage.horizon-museum.org' },
    ],
  },
  {
    id: 'lobby-west-02',
    online: true,
    cpuName: 'Intel Core i7-12700K',
    cpuBase: 28, memBase: 52, memTotal: 64, diskBase: 43, diskTotal: 2000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 58, vramTotal: 12, vramUsed: 7.1 },
    network: { latencyMs: 9, packetLoss: 0, txBps: 1800000, rxBps: 12000000, txUtil: 10, rxUtil: 22, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 4102, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/lobby-west.toe' },
      { id: 'p2', name: 'Node.js', status: 'RUNNING', pid: 9120, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/data-feed/server.js' },
    ],
  },
  {
    id: 'gallery-main',
    online: true,
    cpuName: 'AMD Ryzen 9 7950X',
    cpuBase: 45, memBase: 72, memTotal: 128, diskBase: 38, diskTotal: 4000,
    gpu: { name: 'NVIDIA RTX PRO 6000 (Blackwell)', usageBase: 78, vramTotal: 24, vramUsed: 18.2 },
    network: { latencyMs: 5, packetLoss: 0, txBps: 45000000, rxBps: 28000000, txUtil: 35, rxUtil: 22, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 3310, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/gallery-immersive.toe' },
      { id: 'p2', name: 'OBS Studio', status: 'RUNNING', pid: 7654, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p3', name: 'Node.js', status: 'RUNNING', pid: 2210, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/sensor-bridge/index.js' },
    ],
  },
  {
    id: 'theater-projector',
    online: true,
    cpuName: 'Intel Core i9-13900K',
    cpuBase: 55, memBase: 65, memTotal: 64, diskBase: 61, diskTotal: 2000,
    gpu: { name: 'NVIDIA RTX PRO 5000 (Blackwell)', usageBase: 82, vramTotal: 16, vramUsed: 13.8 },
    network: { latencyMs: 7, packetLoss: 0, txBps: 35000000, rxBps: 20000000, txUtil: 28, rxUtil: 16, linkSpeed: 1000000000 },
    agentVersion: '2.4.0',
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 6710, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/theater-show.toe' },
      { id: 'p2', name: 'VLC', status: 'RUNNING', pid: 1190, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: 'C:/Media/preshow-loop.mp4 --fullscreen --loop' },
    ],
  },
  {
    id: 'kiosk-entrance-1',
    online: true,
    cpuName: 'Intel Core i5-12400',
    cpuBase: 18, memBase: 42, memTotal: 16, diskBase: 55, diskTotal: 512,
    gpu: { name: 'Intel UHD Graphics 730', usageBase: 15, vramTotal: 2, vramUsed: 0.6 },
    network: { latencyMs: 12, packetLoss: 0, txBps: 500000, rxBps: 3000000, txUtil: 4, rxUtil: 8, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'Chrome', status: 'RUNNING', pid: 4450, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://kiosk.horizon-museum.org' },
    ],
  },
  {
    id: 'kiosk-entrance-2',
    online: true,
    cpuName: 'Intel Core i5-12400',
    cpuBase: 15, memBase: 38, memTotal: 16, diskBase: 54, diskTotal: 512,
    gpu: { name: 'Intel UHD Graphics 730', usageBase: 12, vramTotal: 2, vramUsed: 0.5 },
    network: { latencyMs: 11, packetLoss: 0, txBps: 450000, rxBps: 2800000, txUtil: 3, rxUtil: 7, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'Chrome', status: 'RUNNING', pid: 3320, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://kiosk.horizon-museum.org' },
    ],
  },
  {
    id: 'kiosk-gift-shop',
    online: false, // Offline machine for realism
    cpuName: 'Intel Core i5-12400',
    cpuBase: 12, memBase: 35, memTotal: 16, diskBase: 54, diskTotal: 512,
    gpu: { name: 'Intel UHD Graphics 730', usageBase: 10, vramTotal: 2, vramUsed: 0.4 },
    network: { latencyMs: 14, packetLoss: 0, txBps: 200000, rxBps: 1500000, txUtil: 2, rxUtil: 4, linkSpeed: 1000000000 },
    agentVersion: '2.4.0',
    processes: [
      { id: 'p1', name: 'Chrome', status: 'STOPPED', pid: null, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://kiosk.horizon-museum.org/gift-shop' },
    ],
  },
  {
    id: 'stage-left-media',
    online: true,
    cpuName: 'AMD Ryzen 7 7700X',
    cpuBase: 38, memBase: 55, memTotal: 32, diskBase: 48, diskTotal: 1000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 45, vramTotal: 8, vramUsed: 4.8 },
    network: { latencyMs: 6, packetLoss: 0, txBps: 18000000, rxBps: 8000000, txUtil: 15, rxUtil: 10, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'OBS Studio', status: 'RUNNING', pid: 5501, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p2', name: 'VLC', status: 'RUNNING', pid: 6602, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: '' },
      { id: 'p3', name: 'Node.js', status: 'RUNNING', pid: 7703, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/show-control/server.js' },
    ],
  },
  {
    id: 'stage-right-media',
    online: true,
    rebooting: true, // Rebooting machine for realism
    cpuName: 'AMD Ryzen 7 7700X',
    cpuBase: 35, memBase: 50, memTotal: 32, diskBase: 48, diskTotal: 1000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 40, vramTotal: 8, vramUsed: 4.2 },
    network: { latencyMs: 7, packetLoss: 0, txBps: 16000000, rxBps: 7000000, txUtil: 13, rxUtil: 9, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'OBS Studio', status: 'STOPPED', pid: null, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p2', name: 'VLC', status: 'STOPPED', pid: null, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: '' },
    ],
  },
  {
    id: 'admin-workstation',
    online: true,
    cpuName: 'Intel Core i7-13700',
    cpuBase: 22, memBase: 48, memTotal: 32, diskBase: 62, diskTotal: 1000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 18, vramTotal: 12, vramUsed: 3.2 },
    network: { latencyMs: 3, packetLoss: 0, txBps: 800000, rxBps: 5000000, txUtil: 5, rxUtil: 12, linkSpeed: 1000000000 },
    agentVersion: '2.4.1',
    rebootPending: {
      active: true,
      processName: 'Windows Update',
      reason: 'Pending system update requires restart',
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    },
    processes: [
      { id: 'p1', name: 'Chrome', status: 'RUNNING', pid: 9012, autolaunch: false, launch_mode: 'off', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '' },
      { id: 'p2', name: 'Node.js', status: 'RUNNING', pid: 1134, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/admin-panel/server.js' },
      { id: 'p3', name: 'TouchDesigner', status: 'STOPPED', pid: null, autolaunch: false, launch_mode: 'off', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: '' },
    ],
  },
];

// ── Build Machine objects ────────────────────────────────────────────

function buildProcess(def: MachineDef['processes'][number], index: number): Process {
  return {
    ...def,
    schedules: null,
    schedulePresetId: null,
    cwd: '',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    responsive: def.status === 'RUNNING',
    last_updated: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 120),
    index,
  };
}

// ── v2 profile/metric synthesis ──────────────────────────────────────

/**
 * Build a realistic HardwareProfile for a demo machine. Most machines get
 * 2 disks (C: system, D: data) and 2 NICs (Ethernet, Wi-Fi) so the
 * dashboard's per-device dropdowns actually appear and tell a good story.
 * Low-spec kiosks get a single disk and NIC.
 */
function buildProfile(def: MachineDef): HardwareProfile {
  const isLowSpec = def.memTotal <= 16;

  const cpus: CpuProfile[] = [{
    id: 'CPU0',
    model: def.cpuName,
    physicalCores: def.cpuName.includes('i9') || def.cpuName.includes('Ryzen 9') ? 16 : 8,
    logicalCores: def.cpuName.includes('i9') || def.cpuName.includes('Ryzen 9') ? 24 : 16,
    socketIndex: 0,
  }];

  const disks: DiskProfile[] = isLowSpec
    ? [{ id: 'C:', label: 'System', fs: 'NTFS', totalGb: def.diskTotal }]
    : [
        { id: 'C:', label: 'System', fs: 'NTFS', totalGb: Math.round(def.diskTotal * 0.4) },
        { id: 'D:', label: 'Media', fs: 'NTFS', totalGb: Math.round(def.diskTotal * 0.6) },
      ];

  const gpus: GpuProfile[] = def.gpu
    ? [{
        id: 'GPU0',
        name: def.gpu.name,
        vramTotalGb: def.gpu.vramTotal,
        pciBus: '0000:01:00.0',
      }]
    : [];

  const nics: NicProfile[] = isLowSpec
    ? [{ id: 'Ethernet', mac: '00:1A:2B:3C:4D:5E', linkSpeedMbps: 1000 }]
    : [
        { id: 'Ethernet', mac: '00:1A:2B:3C:4D:5E', linkSpeedMbps: 1000 },
        { id: 'Wi-Fi', mac: '00:1A:2B:3C:4D:5F', linkSpeedMbps: 866 },
      ];

  return {
    schemaVersion: 2,
    signatureHash: `demo-${def.id}-profile-hash`,
    capturedAt: Date.now() - 30 * 24 * 3600 * 1000,
    agentVersion: def.agentVersion,
    cpus,
    disks,
    gpus,
    nics,
  };
}

/** Synthesize `devices` the same way `joinMachineDevices` does — since the
 *  demo page consumes `getDemoMachines()` directly (not via useMachines). */
function joinDevices(
  profile: HardwareProfile,
  metrics: NonNullable<Machine['metrics']>,
): NonNullable<Machine['devices']> {
  const buildBucket = <P extends { id: string }, M>(
    profileList: P[],
    metricMap: Record<string, M> | undefined,
  ): DeviceEntry<P, M>[] => {
    const result: DeviceEntry<P, M>[] = [];
    const seen = new Set<string>();
    for (const p of profileList) {
      const metric = metricMap?.[p.id];
      result.push({
        ...p,
        ...(metric ?? {}),
        isMissing: !metric,
        isOrphan: false,
      } as unknown as DeviceEntry<P, M>);
      seen.add(p.id);
    }
    for (const [id, metric] of Object.entries(metricMap ?? {})) {
      if (seen.has(id)) continue;
      result.push({
        id,
        ...(metric as M),
        isMissing: false,
        isOrphan: true,
      } as unknown as DeviceEntry<P, M>);
    }
    return result;
  };

  return {
    cpus: buildBucket<CpuProfile, CpuMetric>(profile.cpus, metrics.cpus),
    disks: buildBucket<DiskProfile, DiskMetric>(profile.disks, metrics.disks),
    gpus: buildBucket<GpuProfile, GpuMetric>(profile.gpus, metrics.gpus),
    nics: buildBucket<NicProfile, NicMetric>(profile.nics, metrics.nics),
  };
}

function buildMachine(def: MachineDef): Machine {
  const now = Math.floor(Date.now() / 1000);
  const heartbeatAge = def.online && !def.rebooting ? 15 + Math.floor(Math.random() * 30) : 300;

  const profile = buildProfile(def);

  // ── CPU metrics ──────────────────────────────────────────────────
  const cpus: Record<string, CpuMetric> = {
    CPU0: {
      percent: def.cpuBase + Math.floor(Math.random() * 8),
      temperature: def.cpuBase > 0 ? 42 + Math.floor(def.cpuBase * 0.4) : null,
    },
  };

  // ── Disk metrics ─────────────────────────────────────────────────
  const disks: Record<string, DiskMetric> = {};
  for (const d of profile.disks) {
    // System disk tracks def.diskBase; data disk runs a bit lower.
    const pct = d.id === 'C:' ? def.diskBase : Math.max(5, def.diskBase - 12);
    disks[d.id] = {
      percent: pct,
      usedGb: +(d.totalGb * (pct / 100)).toFixed(0),
    };
  }

  // ── GPU metrics ──────────────────────────────────────────────────
  const gpus: Record<string, GpuMetric> = {};
  if (def.gpu) {
    gpus.GPU0 = {
      usagePercent: def.gpu.usageBase + Math.floor(Math.random() * 8),
      vramUsedGb: def.gpu.vramUsed,
      temperature: 48 + Math.floor(def.gpu.usageBase * 0.35),
    };
  }

  // ── NIC metrics ──────────────────────────────────────────────────
  const nics: Record<string, NicMetric> = {};
  if (def.network) {
    // Primary NIC (Ethernet) carries the bulk of traffic.
    nics['Ethernet'] = {
      txBps: def.network.txBps,
      rxBps: def.network.rxBps,
      txUtil: def.network.txUtil,
      rxUtil: def.network.rxUtil,
    };
    // Secondary Wi-Fi NIC (if profiled) carries light traffic.
    if (profile.nics.some(n => n.id === 'Wi-Fi')) {
      nics['Wi-Fi'] = {
        txBps: Math.round(def.network.txBps * 0.05),
        rxBps: Math.round(def.network.rxBps * 0.08),
        txUtil: +(def.network.txUtil * 0.1).toFixed(1),
        rxUtil: +(def.network.rxUtil * 0.1).toFixed(1),
      };
    }
  }

  // ── Memory ───────────────────────────────────────────────────────
  const memory: MemoryMetric = {
    percent: def.memBase + Math.floor(Math.random() * 5),
    usedGb: +(def.memTotal * (def.memBase / 100)).toFixed(1),
  };

  // ── Primary device selection (most-active of each kind) ──────────
  const primary: PrimaryDevices = {
    cpu: 'CPU0',
    disk: 'C:',
    gpu: def.gpu ? 'GPU0' : null,
    nic: def.network ? 'Ethernet' : null,
  };

  const metrics: NonNullable<Machine['metrics']> = {
    schemaVersion: 2,
    profileHash: profile.signatureHash,
    timestamp: Date.now(),
    cpus,
    memory,
    disks,
    gpus,
    nics,
    network: def.network
      ? {
          latencyMs: def.network.latencyMs,
          packetLossPct: def.network.packetLoss,
          gatewayIp: '192.168.1.1',
        }
      : {},
    primary,
    processes: Object.fromEntries(
      def.processes.map(p => [p.name, p.status])
    ),
  };

  return {
    machineId: def.id,
    lastHeartbeat: now - heartbeatAge,
    online: def.online,
    agent_version: def.agentVersion,
    rebooting: def.rebooting,
    rebootPending: def.rebootPending,
    profile,
    metrics,
    devices: joinDevices(profile, metrics),
    processes: def.processes.map((p, i) => buildProcess(p, i)),
  };
}

/** Rebuilt on each call so heartbeats stay fresh */
export function getDemoMachines(): Machine[] {
  return machineDefs.map(buildMachine);
}

// ── Sparkline data ───────────────────────────────────────────────────

export interface DemoSparklineData {
  cpu: SparklineDataPoint[];
  memory: SparklineDataPoint[];
  disk: SparklineDataPoint[];
  gpu: SparklineDataPoint[];
  loading: boolean;
}

function generateSparkline(
  rand: () => number,
  base: number,
  amplitude: number,
  points: number = 60,
): SparklineDataPoint[] {
  const now = Math.floor(Date.now() / 1000);
  const result: SparklineDataPoint[] = [];
  for (let i = 0; i < points; i++) {
    const t = now - (points - i) * 60; // 1-minute intervals
    const v = generateMetricValue(rand, base, amplitude, t, 24);
    result.push({ t, v: +v.toFixed(1) });
  }
  return result;
}

export function getDemoSparklineData(machineId: string): DemoSparklineData {
  const def = machineDefs.find(m => m.id === machineId);
  if (!def || !def.online || def.rebooting) {
    return { cpu: [], memory: [], disk: [], gpu: [], loading: false };
  }

  const seed = machineId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = seededRandom(seed);

  return {
    cpu: generateSparkline(rand, def.cpuBase, 12),
    memory: generateSparkline(rand, def.memBase, 6),
    disk: generateSparkline(rand, def.diskBase, 2),
    gpu: def.gpu ? generateSparkline(rand, def.gpu.usageBase, 15) : [],
    loading: false,
  };
}

// ── Historical metrics data ──────────────────────────────────────────

const TIME_RANGE_DURATIONS: Record<TimeRange, number> = {
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
  '1m': 2592000,
  '1y': 31536000,
  'all': 31536000,
};

const TIME_RANGE_POINTS: Record<TimeRange, number> = {
  '1h': 60,
  '1d': 200,
  '1w': 300,
  '1m': 400,
  '1y': 500,
  'all': 500,
};

export function getDemoHistoricalData(
  machineId: string,
  timeRange: TimeRange,
): ChartDataPoint[] {
  const def = machineDefs.find(m => m.id === machineId);
  if (!def || !def.online) return [];

  const seed = machineId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + timeRange.charCodeAt(0);
  const rand = seededRandom(seed);

  const duration = TIME_RANGE_DURATIONS[timeRange];
  const points = TIME_RANGE_POINTS[timeRange];
  const interval = duration / points;
  const now = Math.floor(Date.now() / 1000);

  const data: ChartDataPoint[] = [];
  for (let i = 0; i < points; i++) {
    const t = now - duration + i * interval;

    // Daily pattern: higher during "open hours" (9am-6pm)
    const hourOfDay = ((t % 86400) / 3600 + 8) % 24; // offset for timezone
    const isOpenHours = hourOfDay >= 9 && hourOfDay <= 18;
    const dailyMultiplier = isOpenHours ? 1.0 : 0.4;

    const cpu = generateMetricValue(rand, def.cpuBase * dailyMultiplier, 10, t, 24);
    const memory = generateMetricValue(rand, def.memBase * (dailyMultiplier * 0.6 + 0.4), 5, t, 48);
    const disk = generateMetricValue(rand, def.diskBase, 1, t, 168);

    const point: ChartDataPoint = {
      time: t * 1000, // milliseconds for Recharts
      cpu: +cpu.toFixed(1),
      memory: +memory.toFixed(1),
      disk: +disk.toFixed(1),
    };

    if (def.gpu) {
      point.gpu = +generateMetricValue(rand, def.gpu.usageBase * dailyMultiplier, 15, t, 24).toFixed(1);
    }

    // CPU temp correlated with CPU usage
    if (def.cpuBase > 0) {
      point.cpuTemp = +(42 + cpu * 0.35 + (rand() - 0.5) * 3).toFixed(1);
    }

    // GPU temp correlated with GPU usage
    if (def.gpu && point.gpu) {
      point.gpuTemp = +(48 + point.gpu * 0.32 + (rand() - 0.5) * 3).toFixed(1);
    }

    // Network data (per-NIC keys for Recharts)
    if (def.network) {
      const txUtil = generateMetricValue(rand, def.network.txUtil * dailyMultiplier, 8, t, 24);
      const rxUtil = generateMetricValue(rand, def.network.rxUtil * dailyMultiplier, 6, t, 24);
      point['Ethernet_tx_util'] = +txUtil.toFixed(1);
      point['Ethernet_rx_util'] = +rxUtil.toFixed(1);
      point['Ethernet_tx'] = +(def.network.txBps * (txUtil / (def.network.txUtil || 1)) * dailyMultiplier).toFixed(0);
      point['Ethernet_rx'] = +(def.network.rxBps * (rxUtil / (def.network.rxUtil || 1)) * dailyMultiplier).toFixed(0);
    }

    data.push(point);
  }

  return data;
}

// ── Schedule presets ─────────────────────────────────────────────────

export const DEMO_SCHEDULE_PRESETS = [
  {
    id: 'preset-museum-hours',
    name: 'Museum Hours (9am–6pm)',
    blocks: [
      { id: 'b1', day: 1, start: '09:00', end: '18:00', colorIndex: 0 },
      { id: 'b2', day: 2, start: '09:00', end: '18:00', colorIndex: 0 },
      { id: 'b3', day: 3, start: '09:00', end: '18:00', colorIndex: 0 },
      { id: 'b4', day: 4, start: '09:00', end: '18:00', colorIndex: 0 },
      { id: 'b5', day: 5, start: '09:00', end: '18:00', colorIndex: 0 },
      { id: 'b6', day: 6, start: '10:00', end: '17:00', colorIndex: 0 },
      { id: 'b7', day: 0, start: '10:00', end: '17:00', colorIndex: 0 },
    ],
    isBuiltIn: false,
    order: 1,
    createdBy: 'demo',
  },
  {
    id: 'preset-always-on',
    name: '24/7 Always On',
    blocks: [
      { id: 'b1', day: 0, start: '00:00', end: '23:59', colorIndex: 1 },
      { id: 'b2', day: 1, start: '00:00', end: '23:59', colorIndex: 1 },
      { id: 'b3', day: 2, start: '00:00', end: '23:59', colorIndex: 1 },
      { id: 'b4', day: 3, start: '00:00', end: '23:59', colorIndex: 1 },
      { id: 'b5', day: 4, start: '00:00', end: '23:59', colorIndex: 1 },
      { id: 'b6', day: 5, start: '00:00', end: '23:59', colorIndex: 1 },
      { id: 'b7', day: 6, start: '00:00', end: '23:59', colorIndex: 1 },
    ],
    isBuiltIn: false,
    order: 2,
    createdBy: 'demo',
  },
];
