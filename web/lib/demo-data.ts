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
import type { DisplayProfile, AssignedLayout, MonitorInfo } from '@/hooks/useDisplayState';

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

interface GpuDef { name: string; usageBase: number; vramTotal: number; vramUsed: number }

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
  gpu?: GpuDef;
  /** Additional GPUs beyond the primary — keyed GPU1, GPU2… in profile + metrics. */
  extraGpus?: GpuDef[];
  network?: { latencyMs: number; packetLoss: number; txBps: number; rxBps: number; txUtil: number; rxUtil: number; linkSpeed: number };
  /** Number of monitors whose live config drifts from the assigned layout. */
  displayDriftCount?: number;
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
    displayDriftCount: 1, // projector booted into a different mode than assigned
    agentVersion: '2.4.0',
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 6710, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/theater-show.toe' },
      { id: 'p2', name: 'VLC', status: 'RUNNING', pid: 1190, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: 'C:/Media/preshow-loop.mp4 --fullscreen --loop' },
    ],
  },
  {
    id: 'render-server-01',
    online: true,
    cpuName: 'AMD Ryzen Threadripper PRO 7975WX',
    cpuBase: 62, memBase: 68, memTotal: 256, diskBase: 35, diskTotal: 8000,
    gpu: { name: 'NVIDIA RTX PRO 6000 (Blackwell)', usageBase: 88, vramTotal: 48, vramUsed: 38.4 },
    extraGpus: [
      { name: 'NVIDIA RTX PRO 6000 (Blackwell)', usageBase: 84, vramTotal: 48, vramUsed: 35.1 },
    ],
    network: { latencyMs: 4, packetLoss: 0, txBps: 80000000, rxBps: 60000000, txUtil: 65, rxUtil: 48, linkSpeed: 1000000000 },
    displayDriftCount: 2, // headless server — 2 dummy plugs report unexpected EDIDs
    agentVersion: '2.4.1',
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 8801, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'D:/Projects/render-farm.toe' },
      { id: 'p2', name: 'OBS Studio', status: 'RUNNING', pid: 8802, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p3', name: 'Node.js', status: 'RUNNING', pid: 8803, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/render-queue/worker.js' },
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
    rebooting: true, // Restarting machine for realism (field name is the wire contract)
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
  const isThreadripper = def.cpuName.includes('Threadripper');
  const isHighCore = def.cpuName.includes('i9') || def.cpuName.includes('Ryzen 9');

  const cpus: CpuProfile[] = [{
    id: 'CPU0',
    model: def.cpuName,
    physicalCores: isThreadripper ? 32 : isHighCore ? 16 : 8,
    logicalCores: isThreadripper ? 64 : isHighCore ? 24 : 16,
    socketIndex: 0,
  }];

  const disks: DiskProfile[] = isLowSpec
    ? [{ id: 'C:', label: 'System', fs: 'NTFS', totalGb: def.diskTotal }]
    : [
        { id: 'C:', label: 'System', fs: 'NTFS', totalGb: Math.round(def.diskTotal * 0.4) },
        { id: 'D:', label: 'Media', fs: 'NTFS', totalGb: Math.round(def.diskTotal * 0.6) },
      ];

  const gpus: GpuProfile[] = def.gpu
    ? [
        {
          id: 'GPU0',
          name: def.gpu.name,
          vramTotalGb: def.gpu.vramTotal,
          pciBus: '0000:01:00.0',
        },
        ...(def.extraGpus ?? []).map((g, i) => ({
          id: `GPU${i + 1}`,
          name: g.name,
          vramTotalGb: g.vramTotal,
          // sequential PCI bus addresses (0000:02:00.0, 0000:03:00.0, …)
          pciBus: `0000:${(i + 2).toString(16).padStart(2, '0')}:00.0`,
        })),
      ]
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

  // ── Per-volume disk IO ───────────────────────────────────────────
  // Synthesize plausible read/write rates so the cards' arrow rates and
  // the detail-panel disk-IO chart aren't blank. Skipped for offline
  // and restarting machines (their panels render the empty state).
  const diskio: NonNullable<Machine['metrics']>['diskio'] = {};
  if (def.online && !def.rebooting) {
    // Activity scales with cpu+gpu workload.
    const activity = (def.cpuBase + (def.gpu?.usageBase ?? 0)) / 100; // 0 - ~2
    for (const d of profile.disks) {
      // Media drive (D:) handles bulk reads (project files, video); system
      // drive (C:) handles light reads + steady writes (logs, temp, swap).
      const isMedia = d.id !== 'C:';
      const baseReadBps = isMedia ? 80_000_000 : 3_000_000;
      const baseWriteBps = isMedia ? 12_000_000 : 4_000_000;
      const readBps = Math.round(baseReadBps * activity * (0.7 + Math.random() * 0.6));
      const writeBps = Math.round(baseWriteBps * activity * (0.6 + Math.random() * 0.6));
      // Rough IOPS: large sequential reads → low IOPS; small writes → higher IOPS.
      const readIops = Math.max(1, Math.round(readBps / (isMedia ? 1_048_576 : 65_536)));
      const writeIops = Math.max(1, Math.round(writeBps / 16_384));
      // Busy% — saturate when activity is heavy on the media drive.
      const busyPct = Math.min(95, Math.round((isMedia ? 35 : 8) * activity + Math.random() * 8));
      diskio[d.id] = { readBps, writeBps, readIops, writeIops, busyPct };
    }
  }

  // ── GPU metrics ──────────────────────────────────────────────────
  // Mirrors buildProfile: GPU0 is the primary; extraGpus become GPU1, GPU2…
  // Every profiled GPU gets a live metric here so joinDevices doesn't tag
  // it as `isMissing` in the dashboard's per-device dropdowns.
  const gpus: Record<string, GpuMetric> = {};
  if (def.gpu) {
    gpus.GPU0 = {
      usagePercent: def.gpu.usageBase + Math.floor(Math.random() * 8),
      vramUsedGb: def.gpu.vramUsed,
      temperature: 48 + Math.floor(def.gpu.usageBase * 0.35),
    };
    (def.extraGpus ?? []).forEach((g, i) => {
      gpus[`GPU${i + 1}`] = {
        usagePercent: g.usageBase + Math.floor(Math.random() * 8),
        vramUsedGb: g.vramUsed,
        temperature: 48 + Math.floor(g.usageBase * 0.35),
      };
    });
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
    diskio,
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
    // Sourced from displayTopologies — counts drifted monitors so the card
    // dot agrees with what the panel will compute (the agent does this
    // server-side at heartbeat time in production).
    displayDriftCount: countDemoDrift(def.id),
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

  // Profiled disks/GPUs — must mirror buildProfile so historical chart keys
  // line up with the per-device dropdowns sourced from `metrics.disks`/`gpus`.
  const isLowSpec = def.memTotal <= 16;
  const diskIds = isLowSpec ? ['C:'] : ['C:', 'D:'];
  const gpuDefs = def.gpu
    ? [
        { id: 'GPU0', gpu: def.gpu },
        ...(def.extraGpus ?? []).map((g, i) => ({ id: `GPU${i + 1}`, gpu: g })),
      ]
    : [];

  // Per-volume max bandwidth ceiling for `_io_*_pct` lines (mirrors agent's
  // hardware-class estimate). System SSDs cap lower than the media NVMe.
  const diskMaxBps: Record<string, number> = {
    'C:': 500_000_000,    // ~500 MB/s SATA SSD
    'D:': 3_000_000_000,  // ~3 GB/s NVMe
  };

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

    // Per-disk fill % — system disk tracks def.diskBase, media disk runs lower
    // (mirrors buildMachine's live-metrics derivation).
    for (const id of diskIds) {
      const pct = id === 'C:' ? def.diskBase : Math.max(5, def.diskBase - 12);
      point[`${id}_pct`] = +generateMetricValue(rand, pct, 1, t, 168).toFixed(1);
    }

    // Per-GPU usage + temperature
    for (const { id, gpu } of gpuDefs) {
      const usage = generateMetricValue(rand, gpu.usageBase * dailyMultiplier, 15, t, 24);
      point[`${id}_usage`] = +usage.toFixed(1);
      point[`${id}_temp`] = +(48 + usage * 0.32 + (rand() - 0.5) * 3).toFixed(1);
    }
    // Legacy single-GPU mirror — chart filters these out when {gpuId}_usage exists.
    if (def.gpu) {
      point.gpu = point['GPU0_usage'] as number;
      point.gpuTemp = point['GPU0_temp'] as number;
    }

    // CPU temp correlated with CPU usage
    if (def.cpuBase > 0) {
      point.cpuTemp = +(42 + cpu * 0.35 + (rand() - 0.5) * 3).toFixed(1);
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

    // Per-volume disk IO — emit both bytes (`_io_read`/`_io_write`) and
    // %-of-max-bandwidth (`_io_read_pct`/`_io_write_pct`) plus busy% so the
    // detail panel can flip between modes the same way it does for live data.
    const activity = (def.cpuBase + (def.gpu?.usageBase ?? 0)) / 100; // 0 - ~2
    for (const id of diskIds) {
      const isMedia = id !== 'C:';
      const baseReadBps = isMedia ? 80_000_000 : 3_000_000;
      const baseWriteBps = isMedia ? 12_000_000 : 4_000_000;
      const readBps = Math.max(0, baseReadBps * activity * dailyMultiplier * (0.6 + rand() * 0.8));
      const writeBps = Math.max(0, baseWriteBps * activity * dailyMultiplier * (0.5 + rand() * 0.8));
      const maxBps = diskMaxBps[id] ?? 500_000_000;
      point[`${id}_io_read`] = Math.round(readBps);
      point[`${id}_io_write`] = Math.round(writeBps);
      point[`${id}_io_read_pct`] = +Math.min(100, (readBps / maxBps) * 100).toFixed(2);
      point[`${id}_io_write_pct`] = +Math.min(100, (writeBps / maxBps) * 100).toFixed(2);
      point[`${id}_io_busy`] = +Math.min(95, (isMedia ? 35 : 8) * activity * dailyMultiplier + rand() * 6).toFixed(1);
    }

    data.push(point);
  }

  return data;
}

// ── Display topology ─────────────────────────────────────────────────

/**
 * Build a single MonitorInfo with sensible defaults so the call sites below
 * stay short and obvious. `id` is the Windows-style display path so it looks
 * realistic in the panel; `edidHash` is a stable fake derived from
 * (machineId, slot) so live and assigned monitors line up by identity.
 */
function makeMonitor(
  machineId: string,
  slot: number,
  override: Partial<MonitorInfo> & Pick<MonitorInfo, 'position' | 'resolution'>,
): MonitorInfo {
  const adapterLuid = `0x${(0x1000 + slot).toString(16)}`;
  const defaults: MonitorInfo = {
    id: `\\\\.\\DISPLAY${slot + 1}`,
    edidHash: `demo-${machineId}-edid-${slot}`,
    manufacturerId: 'DEL',
    productCode: '0xA1B2',
    serialNumber: `${machineId.toUpperCase()}-${slot + 1}`,
    friendlyName: `Display ${slot + 1}`,
    position: { x: 0, y: 0 },
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: slot === 0,
    connectionType: 'dp',
    adapterLuid,
    targetId: 0x10000 + slot,
  };
  return { ...defaults, ...override };
}

/**
 * Demo monitor topology per machine. Built lazily so monitor synthesis only
 * runs when a card actually subscribes (most cards subscribe by default since
 * the displays summary is rendered on every collapsed card).
 *
 * Topology choices reflect real-world install patterns:
 *  - lobby / kiosk / single-screen sites: one monitor (kiosks are portrait).
 *  - immersive gallery / render server: 2-3 displays in horizontal layout.
 *  - theater: one large 4K projector.
 *  - admin workstation: two side-by-side desk monitors.
 *
 * Some machines have an assigned layout (admin captured it earlier); others
 * intentionally do not so the panel can demonstrate both states.
 *
 * The `theater-projector` row reports drift: the live config differs from the
 * assigned layout (refresh rate dropped to 30Hz after a power cycle). This
 * also matches the `displayDriftCount: 1` flag set on its metrics shape so
 * the card's amber dot and the panel's drift state are consistent.
 */
const displayTopologies: Record<
  string,
  { live: MonitorInfo[]; assigned: MonitorInfo[] | null }
> = {
  'lobby-east-01': {
    live: [
      makeMonitor('lobby-east-01', 0, {
        friendlyName: 'lobby east',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: [
      makeMonitor('lobby-east-01', 0, {
        friendlyName: 'lobby east',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
  },
  'lobby-west-02': {
    live: [
      makeMonitor('lobby-west-02', 0, {
        friendlyName: 'lobby west',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: null, // not yet captured
  },
  'gallery-main': {
    live: [
      makeMonitor('gallery-main', 0, {
        friendlyName: 'left wall',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 1, {
        friendlyName: 'center wall',
        position: { x: 3840, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 2, {
        friendlyName: 'right wall',
        position: { x: 7680, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
    ],
    assigned: [
      makeMonitor('gallery-main', 0, {
        friendlyName: 'left wall',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 1, {
        friendlyName: 'center wall',
        position: { x: 3840, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 2, {
        friendlyName: 'right wall',
        position: { x: 7680, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
    ],
  },
  'theater-projector': {
    // Live: projector dropped to 30Hz after a power blip — drift vs assigned.
    live: [
      makeMonitor('theater-projector', 0, {
        friendlyName: 'main projector',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
        refreshHz: 30,
        connectionType: 'hdmi',
      }),
    ],
    assigned: [
      makeMonitor('theater-projector', 0, {
        friendlyName: 'main projector',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
        refreshHz: 60,
        connectionType: 'hdmi',
      }),
    ],
  },
  'kiosk-entrance-1': {
    live: [
      makeMonitor('kiosk-entrance-1', 0, {
        friendlyName: 'entrance 1',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
    assigned: [
      makeMonitor('kiosk-entrance-1', 0, {
        friendlyName: 'entrance 1',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
  },
  'kiosk-entrance-2': {
    live: [
      makeMonitor('kiosk-entrance-2', 0, {
        friendlyName: 'entrance 2',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
    assigned: null,
  },
  'kiosk-gift-shop': {
    // Offline machine — last-known live profile still shows so the card has
    // monitors to render even though metrics are stale.
    live: [
      makeMonitor('kiosk-gift-shop', 0, {
        friendlyName: 'gift shop',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
    assigned: null,
  },
  'stage-left-media': {
    live: [
      makeMonitor('stage-left-media', 0, {
        friendlyName: 'preview',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
      makeMonitor('stage-left-media', 1, {
        friendlyName: 'program',
        position: { x: 1920, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: [
      makeMonitor('stage-left-media', 0, {
        friendlyName: 'preview',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
      makeMonitor('stage-left-media', 1, {
        friendlyName: 'program',
        position: { x: 1920, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
  },
  'stage-right-media': {
    // Restarting — leave the last-known profile so the panel isn't blank.
    live: [
      makeMonitor('stage-right-media', 0, {
        friendlyName: 'preview',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
      makeMonitor('stage-right-media', 1, {
        friendlyName: 'program',
        position: { x: 1920, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: null,
  },
  'admin-workstation': {
    live: [
      makeMonitor('admin-workstation', 0, {
        friendlyName: 'left desk',
        position: { x: 0, y: 0 },
        resolution: { width: 2560, height: 1440 },
      }),
      makeMonitor('admin-workstation', 1, {
        friendlyName: 'right desk',
        position: { x: 2560, y: 0 },
        resolution: { width: 2560, height: 1440 },
      }),
    ],
    assigned: null,
  },
};

export interface DemoDisplayState {
  profile: DisplayProfile | null;
  assigned: AssignedLayout | null;
}

export function getDemoDisplayState(machineId: string): DemoDisplayState {
  const topology = displayTopologies[machineId];
  if (!topology) return { profile: null, assigned: null };

  const profile: DisplayProfile = {
    schemaVersion: 1,
    signatureHash: `demo-${machineId}-sig`,
    capturedAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
    monitors: topology.live,
    mosaicActive: false,
  };

  const assigned: AssignedLayout | null = topology.assigned
    ? {
        monitors: topology.assigned,
        capturedAt: Date.now() - 7 * 24 * 3600 * 1000, // 1 week ago
        capturedBy: 'demo@owlette.app',
      }
    : null;

  return { profile, assigned };
}

/**
 * Match-by-edidHash drift count, identical in shape to what the agent
 * publishes via `metrics.displayDriftCount`. Counts a monitor as drifted
 * if any of position/resolution/refreshHz/rotation/scalePct/primary
 * differs between live and assigned. Returns 0 when there's no assigned
 * layout (nothing to drift from).
 */
function countDemoDrift(machineId: string): number {
  const topology = displayTopologies[machineId];
  if (!topology || !topology.assigned) return 0;
  const assignedByHash = new Map<string, MonitorInfo>();
  for (const m of topology.assigned) {
    if (m.edidHash) assignedByHash.set(m.edidHash, m);
  }
  let drifted = 0;
  for (const live of topology.live) {
    const assigned = live.edidHash ? assignedByHash.get(live.edidHash) : undefined;
    if (!assigned) continue;
    const changed =
      live.position.x !== assigned.position.x ||
      live.position.y !== assigned.position.y ||
      live.resolution.width !== assigned.resolution.width ||
      live.resolution.height !== assigned.resolution.height ||
      live.refreshHz !== assigned.refreshHz ||
      live.rotation !== assigned.rotation ||
      live.scalePct !== assigned.scalePct ||
      live.primary !== assigned.primary;
    if (changed) drifted += 1;
  }
  return drifted;
}
