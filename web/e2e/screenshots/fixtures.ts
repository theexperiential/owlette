/**
 * Screenshot fixture helper — deterministic seed data for the marketing
 * screenshot pipeline (api-sprint wave 4.2).
 *
 * Every screenshot scenario must produce byte-identical Firestore state
 * across runs so the resulting PNGs are stable. To get there:
 *
 *   1. Reset the emulator before each scenario (Firestore + Auth).
 *   2. Re-seed the canonical baseline (users + sites) so role-based
 *      storageState fixtures keep working.
 *   3. Use hard-coded ids (`site-screenshot-flagship`, etc.) so URLs and
 *      visible machine-name text are stable across runs.
 *   4. Anchor every relative timestamp to FIXED_NOW_MS — this lets text
 *      like "started 2h ago" / "last restart at 03:14" render the same
 *      pixels regardless of wall-clock time.
 *   5. Drive any "random" data (sparkline series, CPU samples) from a
 *      seeded mulberry32 PRNG so re-runs match.
 *
 * The helper composes the existing primitives from `helpers/seed.ts`
 * (sites, machines, roosts, version history) rather than reinventing
 * them. Cortex chat conversations, alert rules, schedule presets, and the
 * per-frame storyboard state are written inline because no existing
 * helper exposed exactly those shapes.
 *
 * Usage from a screenshot spec:
 *
 *   const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
 *   await page.goto(`/dashboard?site=${ctx.siteId}`);
 *   await page.screenshot({ path: 'public/landing-screens/dashboard.png' });
 *   await ctx.cleanup();
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../helpers/emulator';
import {
  seedMachine,
  seedRoostWithVersionHistory,
  TEST_USERS,
  type SeedMachineOptions,
} from '../helpers/seed';

/* -------------------------------------------------------------------------- */
/*  Public surface                                                            */
/* -------------------------------------------------------------------------- */

export type ScreenshotScenario =
  | 'dashboard-mixed-states'
  | 'monitor-single-machine'
  | 'control-process-restarting'
  | 'deploy-roost-rolling'
  | 'diagnose-cortex-chat'
  | 'display-layout-editor'
  | 'automate-schedule-editor'
  | 'display-storyboard-frame-1'
  | 'display-storyboard-frame-2'
  | 'display-storyboard-frame-3';

export interface ScreenshotFixture {
  siteId: string;
  machineId?: string;
  processId?: string;
  cleanup: () => Promise<void>;
}

/**
 * Seed the firestore emulator with the deterministic state required to
 * render `scenario`. Returns the canonical ids the scenario uses plus a
 * cleanup function the caller invokes (typically in `test.afterEach`).
 *
 * Idempotent: calling twice with the same scenario yields identical state
 * because the emulator is reset before each seed and every write uses
 * fixed ids + fixed timestamps + a seeded PRNG.
 */
export async function seedScreenshotFixtures(
  scenario: ScreenshotScenario,
): Promise<ScreenshotFixture> {
  await resetAndReseedBaseline();

  switch (scenario) {
    case 'dashboard-mixed-states':
      return seedDashboardMixedStates();
    case 'monitor-single-machine':
      return seedMonitorSingleMachine();
    case 'control-process-restarting':
      return seedControlProcessRestarting();
    case 'deploy-roost-rolling':
      return seedDeployRoostRolling();
    case 'diagnose-cortex-chat':
      return seedDiagnoseCortexChat();
    case 'display-layout-editor':
      return seedDisplayLayoutEditor();
    case 'automate-schedule-editor':
      return seedAutomateScheduleEditor();
    case 'display-storyboard-frame-1':
      return seedDisplayStoryboardFrame(1);
    case 'display-storyboard-frame-2':
      return seedDisplayStoryboardFrame(2);
    case 'display-storyboard-frame-3':
      return seedDisplayStoryboardFrame(3);
    default: {
      // Compile-time exhaustiveness check.
      const _exhaustive: never = scenario;
      throw new Error(`unknown screenshot scenario: ${String(_exhaustive)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Determinism helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Anchor for every relative timestamp the dashboard renders. Picked to
 * fall safely outside DST transitions in common timezones so "x hours ago"
 * text doesn't shift between runs. 2026-04-15 14:30:00 UTC.
 */
export const FIXED_NOW_MS = Date.UTC(2026, 3, 15, 14, 30, 0);
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

/** Convert a relative offset (seconds before FIXED_NOW) to a Timestamp. */
function tsAgo(secondsAgo: number): Timestamp {
  return Timestamp.fromMillis(FIXED_NOW_MS - secondsAgo * 1000);
}

/**
 * Tiny seeded PRNG (mulberry32). Same seed → same sequence, so sparkline
 * data and "noise"-style metrics are deterministic across runs.
 */
function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure deterministic site cleanup: removes the seeded site doc + every
 * subcollection we touch. We avoid `clearFirestoreEmulator` here because
 * specs may share emulator lifetime with other tests in the same run.
 */
async function deleteSiteSubtree(siteId: string): Promise<void> {
  const db = getAdminDb();
  const siteRef = db.collection('sites').doc(siteId);
  const configRef = db.collection('config').doc(siteId);

  const subcollectionNames = [
    'machines',
    'roosts',
    'deployments',
    'installer_templates',
    'logs',
  ];

  for (const sub of subcollectionNames) {
    const snap = await siteRef.collection(sub).listDocuments();
    for (const ref of snap) {
      // Recursive delete of any further nested subcollections (machines have
      // hardware/, screenshots/, etc.). recursiveDelete() is exposed on the
      // admin `getRecursiveDeleter`-equivalent — fall back to manual recursion
      // if not available.
      await deleteRecursive(ref);
    }
  }

  // Schedule + reboot presets live under config/{siteId}/...
  const configSubs = ['schedule_presets', 'reboot_presets', 'machines'];
  for (const sub of configSubs) {
    const snap = await configRef.collection(sub).listDocuments();
    for (const ref of snap) {
      await deleteRecursive(ref);
    }
  }

  await siteRef.delete().catch(() => undefined);
  await configRef.delete().catch(() => undefined);
}

async function deleteRecursive(
  ref: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const subcollections = await ref.listCollections();
  for (const c of subcollections) {
    const docs = await c.listDocuments();
    for (const d of docs) {
      await deleteRecursive(d);
    }
  }
  await ref.delete().catch(() => undefined);
}

/**
 * Surgical per-scenario reset: drops only site-A's data. Users in firestore
 * + auth persist from global-setup. We deliberately DO NOT call seedBaseline
 * here — its `seedUser` path calls `auth.updateUser(uid, { password })`,
 * which invalidates existing refresh tokens and breaks the storageState
 * session cookies captured during global-setup. The per-site data
 * (machines, deployments, etc.) is the only thing we need to reset.
 */
async function resetAndReseedBaseline(): Promise<void> {
  await deleteSiteSubtree('site-A');
  // Restore the bare site-A doc (deleteSiteSubtree wiped it). Use merge so
  // the per-scenario seedScreenshotSite call afterwards can layer name/tier
  // on top.
  const db = getAdminDb();
  await db.collection('sites').doc('site-A').set({
    name: 'Site A (Assigned)',
    owner: 'someone-else',
    timezone: 'UTC',
  }, { merge: true });
}

/* -------------------------------------------------------------------------- */
/*  Shared low-level writers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Upgrade the canonical `site-A` baseline doc with the per-scenario name and
 * tier (e.g. `pro` for roost-rolling). We seed into the admin user's already-
 * assigned `site-A` instead of a separate `site-screenshot-*` so the dashboard
 * auto-selects it on load — there's no clean way to force a specific site
 * selection from the spec without races between the firestore writes and the
 * dashboard's site-pick effect.
 */
async function seedScreenshotSite(
  siteId: string,
  name: string,
  ownerUid: string = TEST_USERS.admin.uid,
): Promise<void> {
  const db = getAdminDb();
  // Merge — preserve baseline-set fields (owner, etc) and only update what
  // this scenario needs.
  await db.collection('sites').doc(siteId).set(
    {
      name,
      tier: 'pro',
      timezone: 'America/Los_Angeles',
      createdAt: tsAgo(60 * 60 * 24 * 30),
    },
    { merge: true },
  );
  // Idempotent: admin already has site-A in their sites[] from baseline.
  await db.collection('users').doc(ownerUid).set(
    { sites: FieldValue.arrayUnion(siteId) },
    { merge: true },
  );
}

interface MetricsSample {
  cpuPct: number;
  memPct: number;
  memUsedGb: number;
  gpuPct: number;
  diskPct: number;
}

/**
 * Write a v2-shaped metrics doc onto the machine. Caller controls the
 * sample so each card on the dashboard renders distinct CPU/mem values.
 */
async function writeMachineMetrics(
  siteId: string,
  machineId: string,
  sample: MetricsSample,
  heartbeatOffsetSec = 0,
): Promise<void> {
  const db = getAdminDb();
  const heartbeat = FIXED_NOW_SEC - heartbeatOffsetSec;
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        online: heartbeatOffsetSec < 180,
        lastHeartbeat: heartbeat,
        agent_version: '3.0.0',
        machine_timezone_iana: 'America/Los_Angeles',
        capabilities: { displayRemoteApply: 1 },
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(heartbeatOffsetSec),
          cpus: { CPU0: { percent: sample.cpuPct, temperature: 58 } },
          memory: { percent: sample.memPct, usedGb: sample.memUsedGb },
          disks: {
            'C:': { percent: sample.diskPct, usedGb: 320 },
            'D:': { percent: Math.max(5, sample.diskPct - 12), usedGb: 1450 },
          },
          gpus: {
            'NVIDIA RTX A5000': {
              name: 'NVIDIA RTX A5000',
              usagePercent: sample.gpuPct,
              vramUsedGb: 4.2,
              temperature: 62,
            },
          },
          nics: {
            'Ethernet 1': { txBps: 250_000, rxBps: 1_200_000, txUtil: 2, rxUtil: 12 },
            'Tailscale': { txBps: 80_000, rxBps: 95_000, txUtil: 0.5, rxUtil: 0.6 },
          },
          diskio: {
            'C:': { readBps: 3_000_000, writeBps: 4_000_000, busyPct: 8, maxBps: 500_000_000 },
            'D:': { readBps: 80_000_000, writeBps: 12_000_000, busyPct: 35, maxBps: 3_000_000_000 },
          },
          network: { latencyMs: 12, packetLossPct: 0, gatewayIp: '192.168.1.1' },
          primary: { cpu: 'CPU0', disk: 'C:', gpu: 'NVIDIA RTX A5000', nic: 'Ethernet 1' },
        },
      },
      { merge: true },
    );

  // Hardware profile so useMachines can join devices end-to-end.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('hardware')
    .doc('profile')
    .set({
      schemaVersion: 1,
      signatureHash: `sig-${machineId}`,
      capturedAt: tsAgo(60 * 60 * 24),
      agentVersion: '3.0.0',
      cpus: [
        {
          id: 'CPU0',
          model: 'Intel Xeon W-2295',
          physicalCores: 18,
          logicalCores: 36,
          socketIndex: 0,
        },
      ],
      disks: [
        { id: 'C:', label: 'System', fs: 'NTFS', totalGb: 1000 },
        { id: 'D:', label: 'Media', fs: 'NTFS', totalGb: 4000 },
      ],
      gpus: [
        {
          id: 'NVIDIA RTX A5000',
          name: 'NVIDIA RTX A5000',
          vramTotalGb: 24,
          pciBus: '0000:01:00.0',
        },
      ],
      nics: [
        { id: 'Ethernet 1', mac: '00:1a:2b:3c:4d:5e', linkSpeedMbps: 1000 },
        { id: 'Tailscale', mac: '00:00:00:00:00:01', linkSpeedMbps: 100 },
      ],
    });
}

/* -------------------------------------------------------------------------- */
/*  Scenario: dashboard-mixed-states                                          */
/* -------------------------------------------------------------------------- */

/**
 * Plausible fleet — 10 machines mixing running, alerting, offline, and
 * just-restarted states. CPU/mem distribution is hand-tuned (not all 99%)
 * so the screenshot looks like a real operations view.
 */
async function seedDashboardMixedStates(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  await seedScreenshotSite(siteId, 'flagship');

  type Spec = {
    machineId: string;
    state: 'running' | 'alerting' | 'offline' | 'just-restarted';
    sample: MetricsSample;
    seedOpts?: SeedMachineOptions;
    secondsSinceRestart?: number;
  };

  // 10 machines: 3 running, 4 alerting, 1 offline, 2 just-restarted.
  const specs: Spec[] = [
    { machineId: 'lobby-display', state: 'running',
      sample: { cpuPct: 22, memPct: 38, memUsedGb: 12.1, gpuPct: 18, diskPct: 41 } },
    { machineId: 'museum-kiosk-1', state: 'running',
      sample: { cpuPct: 31, memPct: 44, memUsedGb: 14.0, gpuPct: 26, diskPct: 52 } },
    { machineId: 'museum-kiosk-2', state: 'running',
      sample: { cpuPct: 27, memPct: 40, memUsedGb: 12.7, gpuPct: 21, diskPct: 49 } },

    { machineId: 'media-server-stage', state: 'alerting',
      sample: { cpuPct: 86, memPct: 78, memUsedGb: 49.8, gpuPct: 71, diskPct: 88 } },
    { machineId: 'nyc-signage-01', state: 'alerting',
      sample: { cpuPct: 72, memPct: 81, memUsedGb: 25.9, gpuPct: 64, diskPct: 76 } },
    { machineId: 'unreal-render-1', state: 'alerting',
      sample: { cpuPct: 91, memPct: 65, memUsedGb: 41.4, gpuPct: 94, diskPct: 58 } },
    { machineId: 'td-control-room', state: 'alerting',
      sample: { cpuPct: 79, memPct: 70, memUsedGb: 22.4, gpuPct: 55, diskPct: 67 } },

    { machineId: 'touring-rig-04', state: 'offline',
      sample: { cpuPct: 0, memPct: 0, memUsedGb: 0, gpuPct: 0, diskPct: 0 } },

    { machineId: 'lobby-2', state: 'just-restarted', secondsSinceRestart: 90,
      sample: { cpuPct: 12, memPct: 22, memUsedGb: 7.0, gpuPct: 8, diskPct: 33 } },
    { machineId: 'mainstage-led', state: 'just-restarted', secondsSinceRestart: 240,
      sample: { cpuPct: 18, memPct: 29, memUsedGb: 9.2, gpuPct: 14, diskPct: 38 } },
  ];

  // Per-machine PRNG seeds so each row's sparkline trace looks distinct
  // rather than identical. Stable: machineId → seed.
  const seedFor = (id: string): number =>
    id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0xc0ffee00);

  for (const spec of specs) {
    const heartbeatOffset = spec.state === 'offline' ? 600 : 5;
    await seedMachine(siteId, spec.machineId, {
      ...spec.seedOpts,
      heartbeatOffsetSec: heartbeatOffset,
    });
    await writeMachineMetrics(siteId, spec.machineId, spec.sample, heartbeatOffset);

    // Seed metrics_history so each row's inline sparkline traces render —
    // without these, every row's CPU/RAM/disk/GPU column shows just numbers
    // and a flat baseline. Centered around each machine's current sample so
    // the trace flows naturally into the present.
    if (spec.state !== 'offline') {
      await writeMetricsHistory(siteId, spec.machineId, {
        cpuBase: spec.sample.cpuPct,
        memBase: spec.sample.memPct,
        diskBase: spec.sample.diskPct,
        gpuBase: spec.sample.gpuPct,
        seed: seedFor(spec.machineId),
      });
    }

    if (spec.state === 'just-restarted' && spec.secondsSinceRestart !== undefined) {
      // Stamp a recent reboot completion so the dashboard's "just restarted"
      // chip lights up. Mirrors the agent's post-reboot heartbeat shape.
      await getAdminDb()
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(spec.machineId)
        .set(
          {
            lastRebootCompletedAt: FIXED_NOW_SEC - spec.secondsSinceRestart,
          },
          { merge: true },
        );
    }
  }

  return {
    siteId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/* -------------------------------------------------------------------------- */
/*  Scenario: monitor-single-machine                                          */
/* -------------------------------------------------------------------------- */

/**
 * Multi-machine view focused on `media-server-stage`. Seeds 4 machines with
 * deterministic metrics_history buckets so each card's CPU/memory/disk/GPU
 * sparklines render. The spec opens the focus card's MetricsDetailPanel for
 * the screenshot — surrounding cards stay visible.
 */
async function seedMonitorSingleMachine(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const focusMachineId = 'media-server-stage';
  await seedScreenshotSite(siteId, 'flagship');

  type MachineSpec = {
    id: string;
    metrics: { cpuPct: number; memPct: number; memUsedGb: number; gpuPct: number; diskPct: number };
    history: {
      cpuBase: number;
      memBase: number;
      diskBase: number;
      gpuBase: number;
      seed: number;
      disks?: HistoryDiskSpec[];
      gpus?: HistoryGpuSpec[];
      nics?: HistoryNicSpec[];
    };
  };

  // Two-disk + two-NIC + named-GPU spec for the focused machine — mirrors
  // the production chart's per-device tab discovery (one tab per disk, GPU,
  // and NIC; disks also surface a paired I/O tab via dios[]).
  const focusDisks: HistoryDiskSpec[] = [
    { id: 'C:', pctBase: 73, ioReadBpsBase: 3_000_000, ioWriteBpsBase: 4_000_000, maxBps: 500_000_000 },
    { id: 'D:', pctBase: 61, ioReadBpsBase: 80_000_000, ioWriteBpsBase: 12_000_000, maxBps: 3_000_000_000 },
  ];
  const focusGpus: HistoryGpuSpec[] = [
    { id: 'NVIDIA RTX A5000', usageBase: 55, tempBase: 64 },
  ];
  const focusNics: HistoryNicSpec[] = [
    { id: 'Ethernet 1', txBpsBase: 250_000, rxBpsBase: 1_200_000, txUtilBase: 2, rxUtilBase: 12 },
    { id: 'Tailscale', txBpsBase: 80_000, rxBpsBase: 95_000, txUtilBase: 0.5, rxUtilBase: 0.6 },
  ];

  const machines: MachineSpec[] = [
    {
      id: focusMachineId,
      metrics: { cpuPct: 64, memPct: 71, memUsedGb: 45.2, gpuPct: 58, diskPct: 73 },
      history: {
        cpuBase: 60, memBase: 70, diskBase: 70, gpuBase: 55, seed: 0xfa11ed1a,
        disks: focusDisks,
        gpus: focusGpus,
        nics: focusNics,
      },
    },
    {
      id: 'lobby-display',
      metrics: { cpuPct: 22, memPct: 38, memUsedGb: 12.1, gpuPct: 18, diskPct: 41 },
      history: { cpuBase: 22, memBase: 38, diskBase: 40, gpuBase: 18, seed: 0xb00b1e57 },
    },
    {
      id: 'museum-kiosk-1',
      metrics: { cpuPct: 41, memPct: 53, memUsedGb: 16.8, gpuPct: 31, diskPct: 56 },
      history: { cpuBase: 40, memBase: 52, diskBase: 55, gpuBase: 30, seed: 0xdeadbeef },
    },
    {
      id: 'unreal-render-1',
      metrics: { cpuPct: 78, memPct: 82, memUsedGb: 52.0, gpuPct: 88, diskPct: 64 },
      history: { cpuBase: 75, memBase: 80, diskBase: 60, gpuBase: 85, seed: 0xc0ffee42 },
    },
  ];

  for (const m of machines) {
    await seedMachine(siteId, m.id, { heartbeatOffsetSec: 5 });
    await writeMachineMetrics(siteId, m.id, m.metrics, 5);
    await writeMetricsHistory(siteId, m.id, m.history);
  }

  return {
    siteId,
    machineId: focusMachineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Write a metrics_history bucket the dashboard's `useSparklineData` /
 * `useAllSparklineData` / `useHistoricalMetrics` hooks consume:
 *
 *   sites/{siteId}/machines/{machineId}/metrics_history/{YYYY-MM-DD}
 *     { samples: [{ t, c, m, d, g, ct, gt, ds[], gs[], n[], dios[] }, ...] }
 *
 * Sample shape mirrors the production cloud function at
 * `functions/src/metricsHistory.ts` so the chart panel auto-discovers the
 * same per-device tabs (one per disk, GPU, NIC) and overlay lines (CPU temp
 * paired with CPU usage, GPU temp paired with GPU usage, disk IO read/write
 * pairs) that production users see.
 *
 * Bucket id matches FIXED_NOW because specs `page.clock.install` before
 * navigation; `new Date().toISOString().split('T')[0]` in the page resolves
 * to this bucket.
 */
interface HistoryDiskSpec {
  id: string;
  pctBase: number;
  /** Bytes-per-second base values for IO read / write traces. Optional —
   *  defaults to a small idle rate when omitted. */
  ioReadBpsBase?: number;
  ioWriteBpsBase?: number;
  /** Hardware-class peak bandwidth ceiling for the `_io_*_pct` lines. */
  maxBps?: number;
}
interface HistoryGpuSpec {
  id: string;
  usageBase: number;
  tempBase?: number;
}
interface HistoryNicSpec {
  id: string;
  txBpsBase?: number;
  rxBpsBase?: number;
  txUtilBase?: number;
  rxUtilBase?: number;
}

async function writeMetricsHistory(
  siteId: string,
  machineId: string,
  opts: {
    cpuBase?: number;
    memBase?: number;
    diskBase?: number;
    gpuBase?: number;
    seed?: number;
    sampleCount?: number;
    /** When omitted, derived from `cpuBase` (40 + cpuBase * 0.35). */
    cpuTempBase?: number;
    /** When omitted, derived from `gpuBase` (48 + gpuBase * 0.32). */
    gpuTempBase?: number;
    /** Per-disk usage entries. Defaults to `[{ id: 'C:', pctBase: diskBase }]`. */
    disks?: HistoryDiskSpec[];
    /** Per-GPU entries. Defaults to one entry named `NVIDIA RTX A5000` mapped to `gpuBase`. */
    gpus?: HistoryGpuSpec[];
    /** Per-NIC entries. Defaults to a single low-traffic Ethernet 1 NIC. */
    nics?: HistoryNicSpec[];
  } = {},
): Promise<void> {
  const {
    cpuBase = 50,
    memBase = 60,
    diskBase = 45,
    gpuBase = 35,
    seed = 0xfa11ed1a,
    sampleCount = 60,
    cpuTempBase = 40 + cpuBase * 0.35,
    gpuTempBase = 48 + gpuBase * 0.32,
    disks = [{ id: 'C:', pctBase: diskBase, maxBps: 500_000_000 }],
    gpus = [{ id: 'NVIDIA RTX A5000', usageBase: gpuBase }],
    nics = [{ id: 'Ethernet 1' }],
  } = opts;
  const rng = makePrng(seed);
  const bucketId = new Date(FIXED_NOW_MS).toISOString().split('T')[0];

  // `useHistoricalMetrics` expects sample timestamps in SECONDS — it does
  // `sample.t * 1000` when constructing chart points (see hook). Sparklines
  // use the value directly so either unit works, but the metrics detail
  // chart needs seconds or the line plots off-screen at year 50000+.
  const nowSec = Math.floor(FIXED_NOW_MS / 1000);
  type DiskSample = { i: string; p: number };
  type GpuSample = { i: string; u: number; t?: number };
  type NicSample = { i: string; tx: number; rx: number; tu: number; ru: number };
  type DiskIOSample = { i: string; rb: number; wb: number; bu: number; mb: number };
  type Sample = {
    t: number;
    c: number;
    m: number;
    d: number;
    g: number;
    ct: number;
    gt: number;
    ds: DiskSample[];
    gs: GpuSample[];
    n: NicSample[];
    dios: DiskIOSample[];
  };
  const samples: Sample[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const minutesAgo = sampleCount - i;
    const cpu = clamp(cpuBase + (rng() - 0.5) * 30, 5, 95);
    const memory = clamp(memBase + (rng() - 0.5) * 20, 30, 95);
    const diskAgg = clamp(diskBase + (rng() - 0.5) * 15, 20, 90);
    const gpuAgg = clamp(gpuBase + (rng() - 0.5) * 25, 5, 95);
    const activity = (cpuBase + gpuBase) / 100; // 0 - ~2

    const ds: DiskSample[] = disks.map((d) => ({
      i: d.id,
      p: clamp(d.pctBase + (rng() - 0.5) * 12, 10, 95),
    }));
    const gs: GpuSample[] = gpus.map((g) => {
      const u = clamp(g.usageBase + (rng() - 0.5) * 25, 5, 95);
      const t = clamp((g.tempBase ?? 48 + g.usageBase * 0.32) + (rng() - 0.5) * 4, 35, 92);
      return { i: g.id, u, t };
    });
    const n: NicSample[] = nics.map((nic) => {
      const tx = Math.round((nic.txBpsBase ?? 250_000) * (0.5 + rng() * 1.0));
      const rx = Math.round((nic.rxBpsBase ?? 1_200_000) * (0.5 + rng() * 1.0));
      const tu = clamp((nic.txUtilBase ?? 2) + (rng() - 0.5) * 1.5, 0, 80);
      const ru = clamp((nic.rxUtilBase ?? 12) + (rng() - 0.5) * 4, 0, 80);
      return { i: nic.id, tx, rx, tu, ru };
    });
    const dios: DiskIOSample[] = disks.map((d) => {
      const baseRead = d.ioReadBpsBase ?? 3_000_000;
      const baseWrite = d.ioWriteBpsBase ?? 4_000_000;
      const maxBps = d.maxBps ?? 500_000_000;
      const rb = Math.max(0, Math.round(baseRead * activity * (0.6 + rng() * 0.8)));
      const wb = Math.max(0, Math.round(baseWrite * activity * (0.5 + rng() * 0.8)));
      const bu = clamp(8 * activity + rng() * 6, 0, 95);
      return { i: d.id, rb, wb, bu, mb: maxBps };
    });

    samples.push({
      t: nowSec - minutesAgo * 60,
      c: cpu,
      m: memory,
      d: diskAgg,
      g: gpuAgg,
      ct: clamp(cpuTempBase + (cpu - cpuBase) * 0.4 + (rng() - 0.5) * 3, 35, 90),
      gt: clamp(gpuTempBase + (gpuAgg - gpuBase) * 0.32 + (rng() - 0.5) * 3, 35, 92),
      ds,
      gs,
      n,
      dios,
    });
  }

  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('metrics_history')
    .doc(bucketId)
    .set({ samples });
}

/* -------------------------------------------------------------------------- */
/*  Scenario: control-process-restarting                                      */
/* -------------------------------------------------------------------------- */

/**
 * Multi-machine card-view focused on `td-control-room`'s mid-restart
 * touchdesigner process. Surrounding cards have their own running process
 * sets so the screenshot reads as a populated control surface.
 */
async function seedControlProcessRestarting(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const focusMachineId = 'td-control-room';
  const focusProcessId = 'proc-touchdesigner-main';
  await seedScreenshotSite(siteId, 'flagship');

  type ProcEntry = {
    id: string;
    name: string;
    status: 'RUNNING' | 'LAUNCHING' | 'STOPPED';
    pid: number;
    exe_path: string;
    file_path?: string;
    cwd: string;
    last_updated_offset: number;
    responsive?: boolean;
  };
  type MachineSpec = {
    id: string;
    metrics: { cpuPct: number; memPct: number; memUsedGb: number; gpuPct: number; diskPct: number };
    history: { cpuBase: number; memBase: number; diskBase: number; gpuBase: number; seed: number };
    processes: ProcEntry[];
  };

  const machines: MachineSpec[] = [
    {
      id: focusMachineId,
      metrics: { cpuPct: 38, memPct: 52, memUsedGb: 16.6, gpuPct: 41, diskPct: 47 },
      history: { cpuBase: 36, memBase: 50, diskBase: 47, gpuBase: 40, seed: 0xc0ffee01 },
      processes: [
        {
          id: focusProcessId,
          name: 'touchdesigner.exe',
          status: 'LAUNCHING',
          pid: 4218,
          exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
          file_path: 'C:\\Owlette\\projects\\stage-show\\main.toe',
          cwd: 'C:\\Owlette\\projects\\stage-show',
          last_updated_offset: 4,
          responsive: false,
        },
        {
          id: 'proc-obs-stream',
          name: 'obs64.exe',
          status: 'RUNNING',
          pid: 5102,
          exe_path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
          cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit',
          last_updated_offset: 600,
          responsive: true,
        },
      ],
    },
    {
      id: 'media-server-stage',
      metrics: { cpuPct: 64, memPct: 71, memUsedGb: 45.2, gpuPct: 58, diskPct: 73 },
      history: { cpuBase: 62, memBase: 70, diskBase: 70, gpuBase: 55, seed: 0xc0ffee02 },
      processes: [
        {
          id: 'proc-mediaserver-main',
          name: 'media-server.exe',
          status: 'RUNNING',
          pid: 7320,
          exe_path: 'C:\\Owlette\\bin\\media-server.exe',
          cwd: 'C:\\Owlette\\bin',
          last_updated_offset: 12,
          responsive: true,
        },
      ],
    },
    {
      id: 'mainstage-led',
      metrics: { cpuPct: 28, memPct: 42, memUsedGb: 13.4, gpuPct: 35, diskPct: 51 },
      history: { cpuBase: 28, memBase: 40, diskBase: 50, gpuBase: 35, seed: 0xc0ffee03 },
      processes: [
        {
          id: 'proc-resolume',
          name: 'avenue.exe',
          status: 'RUNNING',
          pid: 9024,
          exe_path: 'C:\\Program Files\\Resolume Avenue\\Avenue.exe',
          cwd: 'C:\\Program Files\\Resolume Avenue',
          last_updated_offset: 30,
          responsive: true,
        },
      ],
    },
    {
      id: 'lobby-display',
      metrics: { cpuPct: 22, memPct: 38, memUsedGb: 12.1, gpuPct: 18, diskPct: 41 },
      history: { cpuBase: 22, memBase: 38, diskBase: 40, gpuBase: 18, seed: 0xc0ffee04 },
      processes: [
        {
          id: 'proc-signage-player',
          name: 'BrightSignSigner.exe',
          status: 'RUNNING',
          pid: 1180,
          exe_path: 'C:\\Owlette\\signage\\BrightSignSigner.exe',
          cwd: 'C:\\Owlette\\signage',
          last_updated_offset: 8,
          responsive: true,
        },
      ],
    },
  ];

  const db = getAdminDb();
  for (let mi = 0; mi < machines.length; mi++) {
    const m = machines[mi];
    await seedMachine(siteId, m.id, { heartbeatOffsetSec: 5 });
    await writeMachineMetrics(siteId, m.id, m.metrics, 5);
    await writeMetricsHistory(siteId, m.id, m.history);

    const processMap: Record<string, unknown> = {};
    m.processes.forEach((p, idx) => {
      processMap[p.id] = {
        name: p.name,
        status: p.status,
        pid: p.pid,
        autolaunch: true,
        launch_mode: 'always',
        exe_path: p.exe_path,
        file_path: p.file_path ?? '',
        cwd: p.cwd,
        priority: 'Normal',
        visibility: 'Show',
        time_delay: '0',
        time_to_init: '5',
        relaunch_attempts: '3',
        responsive: p.responsive ?? true,
        last_updated: FIXED_NOW_SEC - p.last_updated_offset,
        index: idx,
      };
    });

    await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(m.id)
      .set({ metrics: { processes: processMap } }, { merge: true });

    await db
      .collection('config')
      .doc(siteId)
      .collection('machines')
      .doc(m.id)
      .set(
        {
          processes: m.processes.map((p) => ({
            id: p.id,
            name: p.name,
            launch_mode: 'always',
            schedules: null,
          })),
        },
        { merge: true },
      );
  }

  return {
    siteId,
    machineId: focusMachineId,
    processId: focusProcessId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/* -------------------------------------------------------------------------- */
/*  Scenario: deploy-roost-rolling                                            */
/* -------------------------------------------------------------------------- */

/**
 * Site with a roost mid-rollout (3 of 10 machines complete). Tier=pro so
 * the gate from siteTier resolves true.
 */
async function seedDeployRoostRolling(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  await seedScreenshotSite(siteId, 'flagship');

  const machineIds = [
    'lobby-display', 'museum-kiosk-1', 'museum-kiosk-2', 'media-server-stage',
    'nyc-signage-01', 'unreal-render-1', 'td-control-room', 'touring-rig-04',
    'lobby-2', 'mainstage-led',
  ];
  for (const id of machineIds) {
    await seedMachine(siteId, id, { heartbeatOffsetSec: 5 });
    await writeMachineMetrics(siteId, id, {
      cpuPct: 30, memPct: 45, memUsedGb: 14.5, gpuPct: 22, diskPct: 50,
    }, 5);
  }

  // Roost with a current version and 10 targets.
  const roostId = 'stage-show';
  await seedRoostWithVersionHistory(siteId, roostId, {
    name: 'stage show',
    targets: machineIds,
    extractPath: 'C:\\Owlette\\projects\\stage-show',
    versionCount: 4,
    descriptions: [
      'initial version',
      'lighting cue tweaks',
      'audio sync fixes',
      'spring tour build',
    ],
  });

  // Mixed-status deployment list: one in-flight (the canonical preview),
  // one completed, one failed, one queued. The deploy spec clicks the
  // in-progress row to expand it before screenshotting.
  const db = getAdminDb();
  const deploymentsRef = db.collection('sites').doc(siteId).collection('deployments');

  // 1) IN-PROGRESS — the row the spec expands.
  await deploymentsRef.doc('depl-stage-show-v4').set({
    name: 'stage show v4',
    installer_name: 'stage-show.zip',
    installer_url: 'https://e2e-seed.test/roost/stage-show.zip',
    silent_flags: '',
    status: 'in_progress',
    createdAt: tsAgo(60 * 8),
    targets: machineIds.map((mid, idx) => {
      if (idx < 3) {
        return {
          machineId: mid,
          status: 'completed',
          progress: 100,
          completedAt: tsAgo(60 * 5 - idx * 30),
        };
      }
      if (idx === 3) {
        return { machineId: mid, status: 'installing', progress: 64 };
      }
      return { machineId: mid, status: 'pending' };
    }),
  });

  // 2) COMPLETED — finished 2 days ago across the same fleet.
  await deploymentsRef.doc('depl-stage-show-v3').set({
    name: 'stage show v3',
    installer_name: 'stage-show.zip',
    installer_url: 'https://e2e-seed.test/roost/stage-show-v3.zip',
    silent_flags: '',
    status: 'completed',
    createdAt: tsAgo(60 * 60 * 48),
    completedAt: tsAgo(60 * 60 * 47),
    targets: machineIds.map((mid, idx) => ({
      machineId: mid,
      status: 'completed',
      progress: 100,
      completedAt: tsAgo(60 * 60 * 47 - idx * 60),
    })),
  });

  // 3) FAILED — partial rollout that hit an installer error on one machine.
  await deploymentsRef.doc('depl-touchdesigner-driver-update').set({
    name: 'touchdesigner 2024.40000 driver bump',
    installer_name: 'TouchDesigner-2024.40000.exe',
    installer_url: 'https://e2e-seed.test/roost/td-2024.40000.exe',
    silent_flags: '/SILENT',
    status: 'failed',
    createdAt: tsAgo(60 * 60 * 5),
    completedAt: tsAgo(60 * 60 * 4),
    targets: machineIds.slice(0, 4).map((mid, idx) => {
      if (idx < 2) {
        return { machineId: mid, status: 'completed', progress: 100, completedAt: tsAgo(60 * 60 * 4 + 60) };
      }
      if (idx === 2) {
        return { machineId: mid, status: 'failed', progress: 87, error: 'msi exit code 1603 (fatal install error)' };
      }
      return { machineId: mid, status: 'cancelled', progress: 0 };
    }),
  });

  // 4) SCHEDULED — queued for later tonight.
  await deploymentsRef.doc('depl-content-pack-spring').set({
    name: 'spring content pack',
    installer_name: 'content-pack-spring.zip',
    installer_url: 'https://e2e-seed.test/roost/content-pack-spring.zip',
    silent_flags: '',
    status: 'scheduled',
    createdAt: tsAgo(60 * 60 * 1),
    scheduledFor: Timestamp.fromMillis(FIXED_NOW_MS + 60 * 60 * 6 * 1000),
    targets: machineIds.slice(0, 6).map((mid) => ({
      machineId: mid,
      status: 'pending',
      progress: 0,
    })),
  });

  return {
    siteId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/* -------------------------------------------------------------------------- */
/*  Scenario: diagnose-cortex-chat                                            */
/* -------------------------------------------------------------------------- */

/**
 * Cortex chat with a realistic incident-investigation conversation.
 *
 * NOTE: relies on the cortex chat UI surfaces. The cortex regression
 * spec (`web/e2e/specs/cortex/cortex.spec.ts`) renders the same
 * collection (`chats/...`) so the surface is known to exist.
 */
async function seedDiagnoseCortexChat(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'media-server-stage';
  const userId = TEST_USERS.admin.uid;
  await seedScreenshotSite(siteId, 'flagship', userId);
  await seedMachine(siteId, machineId, { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 24, memPct: 36, memUsedGb: 11.5, gpuPct: 18, diskPct: 43,
  }, 5);

  const db = getAdminDb();
  // User's LLM key bypass — without it the cortex page shows a no-key gate.
  await db.collection('users').doc(userId).collection('settings').doc('llm').set({
    provider: 'openai',
    model: 'gpt-4o-mini',
    hasKey: true,
    updatedAt: tsAgo(60 * 60 * 24 * 3),
  });

  // Focus conversation — the spec opens this one for the screenshot.
  const focusConversationId = `screenshot-cortex-${siteId}`;
  await db.collection('chats').doc(focusConversationId).set({
    userId,
    siteId,
    title: '03:14 incident — media-server-stage',
    category: 'Operations',
    targetType: 'machine',
    targetMachineId: machineId,
    machineName: machineId,
    source: 'user',
    messages: [
      {
        id: 'msg-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'what crashed at 3am?' }],
      },
      {
        id: 'msg-assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text:
              'media-server-stage crashed at 03:14 — touchdesigner.exe exit code -1073741819 (access violation). it was auto-restarted at 03:14:08 and has been stable since. the upstream culprit was a CUDA driver hiccup on GPU0; no other machines were affected.',
          },
          {
            type: 'tool-checkLogs',
            toolCallId: 'tool-checklogs-1',
            state: 'output-available',
            args: { machineId, since: '03:00', until: '03:30' },
            output: { matches: 4, level: 'error' },
          },
        ],
      },
      {
        id: 'msg-user-2',
        role: 'user',
        parts: [{ type: 'text', text: 'is it likely to recur tonight?' }],
      },
      {
        id: 'msg-assistant-2',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text:
              'low risk for tonight — the GPU temperature peaked at 84°C right before the crash, and it has been below 70°C since the restart. i recommend pinning the driver to 552.22 (current is 555.85) until the next patch window.',
          },
        ],
      },
    ],
    createdAt: tsAgo(60 * 60 * 9),
    updatedAt: tsAgo(60 * 30),
  });

  // Sidebar fillers — a handful of recent conversations so the sidebar reads
  // as a real working assistant, not a one-off. Lightweight (1-turn each).
  const fillerConversations: Array<{
    id: string;
    title: string;
    category: string;
    machineName: string;
    targetMachineId: string | null;
    userText: string;
    assistantText: string;
    createdAtSecAgo: number;
    updatedAtSecAgo: number;
  }> = [
    {
      id: 'screenshot-cortex-driver-audit',
      title: 'nvidia driver audit across the fleet',
      category: 'Operations',
      machineName: 'all machines',
      targetMachineId: null,
      userText: 'which machines are still on nvidia 552.22?',
      assistantText:
        '4 machines are still on 552.22: media-server-stage, mainstage-led, unreal-render-1, td-control-room. the rest are on 555.85.',
      createdAtSecAgo: 60 * 60 * 24 * 2 + 60 * 30,
      updatedAtSecAgo: 60 * 60 * 24 * 2,
    },
    {
      id: 'screenshot-cortex-disk-warning',
      title: 'disk space warning — museum-kiosk-2',
      category: 'Health',
      machineName: 'museum-kiosk-2',
      targetMachineId: 'museum-kiosk-2',
      userText: "museum-kiosk-2 says it's at 92% disk. what's eating it?",
      assistantText:
        '88GB is in C:\\Owlette\\projects\\stage-show\\renders — looks like the auto-render cache hasn\'t been pruned since february. safe to clear; nothing in there is referenced by the current roost manifest.',
      createdAtSecAgo: 60 * 60 * 5,
      updatedAtSecAgo: 60 * 60 * 4,
    },
    {
      id: 'screenshot-cortex-restart-sequence',
      title: 'startup sequence for opening night',
      category: 'Operations',
      machineName: 'mainstage-led',
      targetMachineId: 'mainstage-led',
      userText: 'walk me through the boot order for mainstage-led on opening night.',
      assistantText:
        'sequence: 1) BrightSignSigner waits 8s for the LED matrix to handshake, 2) avenue.exe launches with the spring-tour.avc composition, 3) td-control-room starts main.toe and signals avenue over osc once it\'s ready. total time-to-show is roughly 45 seconds from cold boot.',
      createdAtSecAgo: 60 * 60 * 24 * 1,
      updatedAtSecAgo: 60 * 60 * 22,
    },
    {
      id: 'screenshot-cortex-license-check',
      title: 'touchdesigner license expiry',
      category: 'Compliance',
      machineName: 'all machines',
      targetMachineId: null,
      userText: 'when do our touchdesigner pro licenses expire?',
      assistantText:
        'all 6 td-pro licenses renew on 2026-09-14. the seat assigned to td-control-room is the only one set to auto-renew; the rest will need a manual nudge in derivative\'s portal in september.',
      createdAtSecAgo: 60 * 60 * 24 * 4,
      updatedAtSecAgo: 60 * 60 * 24 * 4,
    },
  ];

  for (const c of fillerConversations) {
    await db.collection('chats').doc(c.id).set({
      userId,
      siteId,
      title: c.title,
      category: c.category,
      targetType: c.targetMachineId ? 'machine' : 'site',
      targetMachineId: c.targetMachineId,
      machineName: c.machineName,
      source: 'user',
      messages: [
        {
          id: `${c.id}-msg-user-1`,
          role: 'user',
          parts: [{ type: 'text', text: c.userText }],
        },
        {
          id: `${c.id}-msg-assistant-1`,
          role: 'assistant',
          parts: [{ type: 'text', text: c.assistantText }],
        },
      ],
      createdAt: tsAgo(c.createdAtSecAgo),
      updatedAt: tsAgo(c.updatedAtSecAgo),
    });
  }

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/* -------------------------------------------------------------------------- */
/*  Scenario: display-layout-editor                                           */
/* -------------------------------------------------------------------------- */

/**
 * 4-monitor 2×2 mosaic layout. Profile lives under
 * `sites/{siteId}/machines/{machineId}/hardware/display`; assignment lives
 * under `config/{siteId}/machines/{machineId}.displays.assigned` per the
 * setDisplayLayout action.
 */
async function seedDisplayLayoutEditor(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'mainstage-led';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, {
    heartbeatOffsetSec: 5,
    monitorCount: 0, // we'll write a custom 4-monitor profile below
  });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 28, memPct: 42, memUsedGb: 13.4, gpuPct: 35, diskPct: 51,
  }, 5);

  await writeFourMonitorProfile(siteId, machineId);

  // Assigned layout under the config doc — what the screenshot view renders
  // as "the layout this machine should look like".
  const db = getAdminDb();
  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        displays: {
          assigned: {
            monitors: buildFourMonitorTopology(machineId),
            capturedAt: tsAgo(60 * 60 * 24 * 2),
            capturedBy: 'admin@e2e.test',
          },
          autoRestore: { enabled: true, enabledBy: 'admin@e2e.test' },
          remoteApplyEnabled: true,
        },
      },
      { merge: true },
    );

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

interface MonitorTopologyEntry {
  id: string;
  edidHash: string;
  manufacturerId: string;
  productCode: string;
  serialNumber: string;
  friendlyName: string;
  position: { x: number; y: number };
  resolution: { width: number; height: number };
  refreshHz: number;
  rotation: number;
  scalePct: number;
  primary: boolean;
  connectionType: string;
  adapterLuid: string;
  targetId: number;
}

/** Four 1920×1080 monitors arranged 2×2 (top-left primary). */
function buildFourMonitorTopology(machineId: string): MonitorTopologyEntry[] {
  const positions = [
    { x: 0,    y: 0,    primary: true },
    { x: 1920, y: 0,    primary: false },
    { x: 0,    y: 1080, primary: false },
    { x: 1920, y: 1080, primary: false },
  ];
  return positions.map((p, i) => ({
    id: `MONITOR\\MAIN${i}`,
    edidHash: `hash-${machineId}-${i}`,
    manufacturerId: 'SAM',
    productCode: `0E0${i}`,
    serialNumber: `SN-${machineId}-${i}`,
    friendlyName: `Mainstage ${i + 1}`,
    position: { x: p.x, y: p.y },
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: p.primary,
    connectionType: 'dp',
    adapterLuid: '0:1',
    targetId: i,
  }));
}

async function writeFourMonitorProfile(
  siteId: string,
  machineId: string,
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('hardware')
    .doc('display')
    .set({
      schemaVersion: 1,
      signatureHash: `sig-${machineId}`,
      capturedAt: FIXED_NOW_MS,
      monitors: buildFourMonitorTopology(machineId),
      mosaicActive: false,
    });
}

/* -------------------------------------------------------------------------- */
/*  Scenario: automate-schedule-editor                                        */
/* -------------------------------------------------------------------------- */

/**
 * Schedule editor with reboot schedule + a couple of process schedule
 * presets, plus an alert-rule entry. Surfaces:
 *
 *   - `config/{siteId}/machines/{machineId}.rebootSchedule`
 *   - `config/{siteId}/schedule_presets/*`
 *   - `sites/{siteId}/alertRules/*`
 *
 * NOTE: alert-rule UI surface depends on `setAlertRules` action — confirmed
 * present in `web/lib/actions/setAlertRules.server.ts`.
 */
async function seedAutomateScheduleEditor(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'lobby-display';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 19, memPct: 31, memUsedGb: 9.9, gpuPct: 12, diskPct: 36,
  }, 5);
  await seedMachine(siteId, 'media-server-stage', { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, 'media-server-stage', {
    cpuPct: 92, memPct: 78, memUsedGb: 49.9, gpuPct: 88, diskPct: 81,
  }, 5);

  const db = getAdminDb();
  // Reboot schedule on the lobby display — fires every Monday at 04:00.
  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        rebootSchedule: {
          enabled: true,
          entries: [
            { id: 'sched-monday-0400', days: ['mon'], time: '04:00' },
            { id: 'sched-friday-2300', days: ['fri'], time: '23:00' },
          ],
        },
      },
      { merge: true },
    );

  // Schedule presets — one custom on top of the built-ins.
  await db
    .collection('config')
    .doc(siteId)
    .collection('schedule_presets')
    .doc('preset-museum-hours')
    .set({
      name: 'museum hours',
      description: 'tue–sun 10am–5pm (closed mon)',
      blocks: [
        {
          days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          ranges: [{ start: '10:00', stop: '17:00' }],
          colorIndex: 2,
        },
      ],
      isBuiltIn: false,
      order: 100,
      createdBy: TEST_USERS.admin.uid,
      createdAt: tsAgo(60 * 60 * 24 * 14),
      updatedAt: tsAgo(60 * 60 * 24 * 7),
    });

  // Alert rule — fires when CPU > 90% for 5 minutes on media-server-stage.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('alertRules')
    .doc('rule-cpu-stage')
    .set({
      kind: 'threshold',
      machineId: 'media-server-stage',
      metric: 'cpu',
      comparator: 'gt',
      threshold: 90,
      durationSec: 300,
      action: 'restart_process',
      processId: 'proc-touchdesigner-main',
      enabled: true,
      createdAt: tsAgo(60 * 60 * 24 * 2),
      updatedAt: tsAgo(60 * 60 * 6),
    });

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/* -------------------------------------------------------------------------- */
/*  Scenario: display-storyboard frames 1/2/3                                 */
/* -------------------------------------------------------------------------- */

/**
 * Three states of the same display layout for the marketing storyboard:
 *
 *   1. before-apply: drift detected, "apply" button enabled
 *   2. mid-apply:    countdown banner (rebootScheduledAt set), apply pending
 *   3. ack received: layout reapplied, drift cleared, success banner
 *
 * All three frames share the same site/machine ids so URLs are consistent
 * across screenshots; the only thing that differs is the per-frame state
 * (drift count, countdown anchor, banner field).
 */
async function seedDisplayStoryboardFrame(
  frame: 1 | 2 | 3,
): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'mainstage-led';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, {
    heartbeatOffsetSec: 5,
    monitorCount: 0,
  });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 28, memPct: 42, memUsedGb: 13.4, gpuPct: 35, diskPct: 51,
  }, 5);
  await writeFourMonitorProfile(siteId, machineId);

  const db = getAdminDb();
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const configRef = db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);

  // Base assignment — same in all three frames.
  await configRef.set(
    {
      displays: {
        assigned: {
          monitors: buildFourMonitorTopology(machineId),
          capturedAt: tsAgo(60 * 60 * 24 * 2),
          capturedBy: 'admin@e2e.test',
        },
        autoRestore: { enabled: true, enabledBy: 'admin@e2e.test' },
        remoteApplyEnabled: true,
      },
    },
    { merge: true },
  );

  if (frame === 1) {
    // Drift detected — surface the displayDriftCount on the status doc so
    // the dashboard's drift dot lights up and the storyboard intro panel
    // shows the "apply" CTA.
    await machineRef.set(
      {
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(5),
          displayDriftCount: 2,
        },
      },
      { merge: true },
    );
  } else if (frame === 2) {
    // Mid-apply — countdown banner anchored 25 seconds into the future.
    await machineRef.set(
      {
        rebooting: false,
        // No reboot — display layout apply doesn't reboot the box. We use
        // the storyboard-specific countdown field that the display panel
        // listens to.
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(2),
          displayDriftCount: 2,
        },
      },
      { merge: true },
    );
    await configRef.set(
      {
        displays: {
          remoteApply: {
            inFlight: true,
            scheduledAt: FIXED_NOW_SEC + 25,
            requestedBy: 'admin@e2e.test',
          },
        },
      },
      { merge: true },
    );
  } else {
    // Ack received — drift cleared, last-applied banner stamped.
    await machineRef.set(
      {
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(5),
          displayDriftCount: 0,
        },
      },
      { merge: true },
    );
    await configRef.set(
      {
        displays: {
          remoteApply: {
            inFlight: false,
            lastAppliedAt: FIXED_NOW_MS - 8 * 1000,
            lastAppliedBy: 'admin@e2e.test',
          },
        },
      },
      { merge: true },
    );
  }

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

