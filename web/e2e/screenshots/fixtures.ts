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
import {
  clearAuthEmulator,
  clearFirestoreEmulator,
  getAdminDb,
} from '../helpers/emulator';
import {
  seedBaseline,
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

/** Reset the entire emulator (Firestore + Auth) and re-seed users/sites. */
async function resetAndReseedBaseline(): Promise<void> {
  await Promise.all([clearFirestoreEmulator(), clearAuthEmulator()]);
  await seedBaseline();
}

/* -------------------------------------------------------------------------- */
/*  Shared low-level writers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create the screenshot-pipeline site. We intentionally don't use the
 * canonical `site-A` / `site-B` from the baseline so screenshots aren't
 * confused with the regression suite's data.
 */
async function seedScreenshotSite(
  siteId: string,
  name: string,
  ownerUid: string = TEST_USERS.admin.uid,
): Promise<void> {
  const db = getAdminDb();
  await db.collection('sites').doc(siteId).set({
    name,
    owner: ownerUid,
    timezone: 'America/Los_Angeles',
    tier: 'pro',
    createdAt: tsAgo(60 * 60 * 24 * 30), // 30d ago
  });
  // Add the site to the admin user's sites[] so they can navigate to it
  // when storageState boots them into the dashboard.
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
          disks: { 'C:': { percent: sample.diskPct, usedGb: 320 } },
          gpus: {
            GPU0: {
              usagePercent: sample.gpuPct,
              vramUsedGb: 4.2,
              temperature: 62,
            },
          },
          nics: {
            'Ethernet 1': { txBps: 250_000, rxBps: 1_200_000, txUtil: 2, rxUtil: 12 },
          },
          network: { latencyMs: 12, packetLossPct: 0, gatewayIp: '192.168.1.1' },
          primary: { cpu: 'CPU0', disk: 'C:', gpu: 'GPU0', nic: 'Ethernet 1' },
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
      disks: [{ id: 'C:', label: 'System', fs: 'NTFS', totalGb: 1000 }],
      gpus: [
        {
          id: 'GPU0',
          name: 'NVIDIA RTX A5000',
          vramTotalGb: 24,
          pciBus: '0000:01:00.0',
        },
      ],
      nics: [{ id: 'Ethernet 1', mac: '00:1a:2b:3c:4d:5e', linkSpeedMbps: 1000 }],
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
  const siteId = 'site-screenshot-flagship';
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

  for (const spec of specs) {
    const heartbeatOffset = spec.state === 'offline' ? 600 : 5;
    await seedMachine(siteId, spec.machineId, {
      ...spec.seedOpts,
      heartbeatOffsetSec: heartbeatOffset,
    });
    await writeMachineMetrics(siteId, spec.machineId, spec.sample, heartbeatOffset);

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
 * Single machine view. Adds a deterministic 60-sample sparkline series so
 * the metrics charts have realistic variance instead of flat lines.
 */
async function seedMonitorSingleMachine(): Promise<ScreenshotFixture> {
  const siteId = 'site-screenshot-monitor';
  const machineId = 'media-server-stage';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 64, memPct: 71, memUsedGb: 45.2, gpuPct: 58, diskPct: 73,
  }, 5);

  // Seed a 60-minute sparkline by writing one historical metrics doc per
  // minute. PRNG seeded from a fixed integer so values reproduce exactly.
  const rng = makePrng(0xfa11ed1a);
  const db = getAdminDb();
  const histRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('historical_metrics');

  for (let i = 0; i < 60; i++) {
    const minutesAgo = 60 - i;
    // Random walk around 60% CPU / 70% mem so the sparkline has realistic
    // variance without spikes.
    const cpu = clamp(60 + (rng() - 0.5) * 30, 5, 95);
    const mem = clamp(70 + (rng() - 0.5) * 20, 30, 95);
    const gpu = clamp(55 + (rng() - 0.5) * 25, 5, 95);
    await histRef.doc(`m-${i.toString().padStart(2, '0')}`).set({
      timestamp: tsAgo(minutesAgo * 60),
      cpus: { CPU0: { percent: cpu } },
      memory: { percent: mem, usedGb: 32 + (mem / 100) * 32 },
      gpus: { GPU0: { usagePercent: gpu } },
    });
  }

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/* -------------------------------------------------------------------------- */
/*  Scenario: control-process-restarting                                      */
/* -------------------------------------------------------------------------- */

/**
 * One machine with a touchdesigner process mid-restart (status=LAUNCHING)
 * — the control surface renders a status banner under the process row.
 */
async function seedControlProcessRestarting(): Promise<ScreenshotFixture> {
  const siteId = 'site-screenshot-control';
  const machineId = 'td-control-room';
  const processId = 'proc-touchdesigner-main';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 38, memPct: 52, memUsedGb: 16.6, gpuPct: 41, diskPct: 47,
  }, 5);

  // Status doc carries the live process map; config doc carries the
  // launch_mode override. Both writes mirror what the agent emits during
  // a process restart.
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        metrics: {
          processes: {
            [processId]: {
              name: 'touchdesigner.exe',
              status: 'LAUNCHING',
              pid: 4218,
              autolaunch: true,
              launch_mode: 'always',
              exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
              file_path: 'C:\\Owlette\\projects\\stage-show\\main.toe',
              cwd: 'C:\\Owlette\\projects\\stage-show',
              priority: 'High',
              visibility: 'Show',
              time_delay: '5',
              time_to_init: '15',
              relaunch_attempts: '3',
              responsive: false,
              last_updated: FIXED_NOW_SEC - 4,
              index: 0,
            },
            'proc-obs-stream': {
              name: 'obs64.exe',
              status: 'RUNNING',
              pid: 5102,
              autolaunch: true,
              launch_mode: 'always',
              exe_path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
              file_path: '',
              cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit',
              priority: 'Normal',
              visibility: 'Show',
              time_delay: '0',
              time_to_init: '5',
              relaunch_attempts: '3',
              responsive: true,
              last_updated: FIXED_NOW_SEC - 600,
              index: 1,
            },
          },
        },
      },
      { merge: true },
    );

  // Config doc — authoritative launch_mode (matches what useMachines reads).
  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        processes: [
          {
            id: processId,
            name: 'touchdesigner.exe',
            launch_mode: 'always',
            schedules: null,
          },
          {
            id: 'proc-obs-stream',
            name: 'obs64.exe',
            launch_mode: 'always',
            schedules: null,
          },
        ],
      },
      { merge: true },
    );

  return {
    siteId,
    machineId,
    processId,
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
  const siteId = 'site-screenshot-deploy';
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

  // In-flight deployment record — 3 done, 1 in progress, 6 pending. The
  // dashboard surfaces these via `sites/{siteId}/deployments` so the rollout
  // bar reads "3 of 10 complete".
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc('depl-stage-show-v4')
    .set({
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
  const siteId = 'site-screenshot-cortex';
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

  const conversationId = `screenshot-cortex-${siteId}`;
  await db.collection('chats').doc(conversationId).set({
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
  const siteId = 'site-screenshot-display';
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
  const siteId = 'site-screenshot-automate';
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
  const siteId = 'site-screenshot-storyboard';
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

