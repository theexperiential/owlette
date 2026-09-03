/**
 * Deterministic test data for the Firestore + Auth emulators. Called by
 * global-setup; specs may also call these to extend the baseline.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from './emulator';

export type TestRole = 'member' | 'admin' | 'superadmin';

export interface TestUser {
  uid: string;
  email: string;
  password: string;
  role: TestRole;
  sites: string[];
  displayName?: string;
}

/**
 * Canonical test-user fleet; mirrors scripts/test-rules.mjs. admin-uid is a
 * site-admin on site-A, not a platform superadmin. super-uid has empty sites[]
 * and reaches everything via the canAccessSite fall-through.
 */
export const TEST_USERS: Record<TestRole, TestUser> = {
  member: {
    uid: 'member-uid',
    email: 'member@e2e.test',
    password: 'e2e-member-password',
    role: 'member',
    sites: ['site-A'],
    displayName: 'E2E Member',
  },
  admin: {
    uid: 'admin-uid',
    email: 'admin@e2e.test',
    password: 'e2e-admin-password',
    role: 'admin',
    sites: ['site-A'],
    displayName: 'E2E Admin',
  },
  superadmin: {
    uid: 'super-uid',
    email: 'super@e2e.test',
    password: 'e2e-super-password',
    role: 'superadmin',
    sites: [],
    displayName: 'E2E Superadmin',
  },
};

/**
 * Create the Auth account (if missing) and the Firestore users/{uid} doc.
 * MFA is pre-satisfied so the redirect gates in dashboard/ and login/ don't
 * trip the E2E flow.
 */
export async function seedUser(user: TestUser): Promise<void> {
  const auth = getAdminAuth();
  const db = getAdminDb();

  // Idempotent: update if the uid/email already exists.
  try {
    await auth.createUser({
      uid: user.uid,
      email: user.email,
      password: user.password,
      displayName: user.displayName,
      emailVerified: true,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(user.uid, {
        email: user.email,
        password: user.password,
        displayName: user.displayName,
        emailVerified: true,
      });
    } else {
      throw err;
    }
  }

  await db.collection('users').doc(user.uid).set({
    email: user.email,
    role: user.role,
    sites: user.sites,
    displayName: user.displayName ?? '',
    createdAt: new Date(),
    // MFA bypass — avoids the /setup-2fa and /verify-2fa redirect gates.
    // `mfaFactors` is what the app reads (lib/mfaFactors.server.ts derives
    // mfaEnrolled from it); seed it explicitly or the fixture looks like an
    // account whose inventory was never computed. Legacy `passkeyEnrolled` is
    // deliberately not seeded — nothing reads it any more.
    mfaEnrolled: false,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 0 },
    preferences: {
      temperatureUnit: 'C',
      timezone: 'UTC',
      timeFormat: '12h',
      timeDisplayMode: 'machine',
      healthAlerts: true,
      processAlerts: true,
      thresholdAlerts: true,
      cortexAlerts: true,
      mutedMachines: [],
      alertCcEmails: [],
      statsExpanded: true,
      processesExpanded: true,
    },
  });
}

export interface TestSite {
  id: string;
  name: string;
  owner: string; // uid of site owner; doesn't have to be a test user
  timezone?: string;
}

export const TEST_SITES: TestSite[] = [
  { id: 'site-A', name: 'Site A (Assigned)', owner: 'someone-else', timezone: 'UTC' },
  { id: 'site-B', name: 'Site B (Unassigned)', owner: 'someone-else', timezone: 'UTC' },
];

export async function seedSite(site: TestSite): Promise<void> {
  const db = getAdminDb();
  await db.collection('sites').doc(site.id).set({
    name: site.name,
    owner: site.owner,
    timezone: site.timezone ?? 'UTC',
    createdAt: new Date(),
  });
}

/** The canonical baseline: three users + two sites. Called by global-setup. */
export async function seedBaseline(): Promise<void> {
  // Sites first — some rules guards reference site docs via get().
  await Promise.all(TEST_SITES.map(seedSite));
  await Promise.all(Object.values(TEST_USERS).map(seedUser));
}

export interface SeedMachineOptions {
  /** Custom display name (defaults to machineId). */
  displayName?: string;
  /** Seconds to backdate `lastHeartbeat`. >300 reads as offline (useMachines). */
  heartbeatOffsetSec?: number;
  /** Monitors in the display profile. Default 2; 0 writes no display subdoc. */
  monitorCount?: number;
  /**
   * Explicit per-monitor specs — overrides `monitorCount`'s uniform dual
   * 1920×1080. Added when the mixed-states fleet read as fake: every machine
   * carried the same two "Test Monitor" screens on camera. Positions are
   * computed left-to-right; rotation 90/270 swaps the footprint.
   */
  monitors?: Array<{
    widthPx: number;
    heightPx: number;
    rotation?: 0 | 90 | 180 | 270;
    friendlyName?: string;
  }>;
  /**
   * Seconds until an in-flight reboot fires. Writes `rebooting` +
   * `rebootScheduledAt` so MachineStatusPill renders its countdown variant.
   */
  rebootingInSec?: number;
  /**
   * The amber "reboot pending" banner (card view only), which the agent writes
   * after a process crash. `true` for defaults, or an object to override.
   */
  rebootPending?:
    | boolean
    | {
        processName?: string;
        reason?: string;
      };
}

/**
 * Seed a machine with enough state for the dashboard card AND for
 * DisplayLayoutPanel to mount a real profile. Writes the status doc plus
 * `hardware/display` (what `useDisplayState` subscribes to). The Admin SDK
 * bypasses firestore.rules, so auth state is irrelevant. Overwrites on re-run.
 */
export async function seedMachine(
  siteId: string,
  machineId: string,
  opts: SeedMachineOptions = {},
): Promise<void> {
  const db = getAdminDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const heartbeat = nowSec - (opts.heartbeatOffsetSec ?? 0);
  const monitorCount = opts.monitorCount ?? 2;

  // Mirrors what the agent writes mid-reboot. `rebootScheduledAt` is Unix
  // seconds; `rebooting: true` keeps the pill active past the target time.
  const rebootingExtras =
    typeof opts.rebootingInSec === 'number'
      ? {
          rebooting: true,
          rebootScheduledAt: nowSec + opts.rebootingInSec,
        }
      : {};

  const rebootPendingExtras = opts.rebootPending
    ? {
        rebootPending: {
          active: true,
          processName:
            typeof opts.rebootPending === 'object'
              ? opts.rebootPending.processName ?? 'test-process'
              : 'test-process',
          reason:
            typeof opts.rebootPending === 'object'
              ? opts.rebootPending.reason ?? 'process crashed'
              : 'process crashed',
          timestamp: nowSec,
        },
      }
    : {};

  // Status doc for useMachines. Empty `metrics` keeps the card minimal — the
  // display-panel test needs no sparkline data.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set({
      online: true,
      lastHeartbeat: heartbeat,
      agent_version: '2.9.0',
      machine_timezone_iana: 'UTC',
      // Without the capability handshake the recall button stays disabled on an
      // "agent too old" tooltip, breaking every recall spec.
      capabilities: { displayRemoteApply: 1 },
      metrics: {
        schemaVersion: 2,
        timestamp: new Date(),
      },
      ...rebootingExtras,
      ...rebootPendingExtras,
    });

  // Offset positions so DisplayCanvas has something non-trivial to render.
  // `edidHash` is the drift-matching identity key — synthetic but stable, so
  // re-runs are deterministic.
  const monitorSpecs =
    opts.monitors ??
    (monitorCount > 0
      ? Array.from({ length: monitorCount }, () => ({
          widthPx: 1920,
          heightPx: 1080,
          rotation: 0 as const,
          friendlyName: undefined,
        }))
      : []);
  if (monitorSpecs.length > 0) {
    let cursorX = 0;
    const monitors = monitorSpecs.map((m, i) => {
      const rotated = m.rotation === 90 || m.rotation === 270;
      const rec = {
        id: `MONITOR\\TEST${i}`,
        edidHash: `hash-${machineId}-${i}`,
        manufacturerId: 'TST',
        productCode: `000${i}`,
        serialNumber: `SN${i}`,
        friendlyName: m.friendlyName ?? `Test Monitor ${i + 1}`,
        position: { x: cursorX, y: 0 },
        resolution: { width: m.widthPx, height: m.heightPx },
        refreshHz: 60,
        rotation: m.rotation ?? 0,
        scalePct: 100,
        primary: i === 0,
        connectionType: 'dp',
        adapterLuid: '0:0',
        targetId: i,
      };
      cursorX += rotated ? m.heightPx : m.widthPx;
      return rec;
    });

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
        capturedAt: Date.now(),
        monitors,
        mosaicActive: false,
      });
  }
}

export interface SeedRoostOptions {
  /** Display name. Defaults to the roostId. */
  name?: string;
  /** Machine ids this roost deploys to. Defaults to []. */
  targets?: string[];
  /** Optional extract path on the agent side. */
  extractPath?: string;
  /** Starting version counter. Defaults to 0 (no versions yet). */
  versionCounter?: number;
}

/**
 * Roost doc only — version pointers stay null until `seedVersion` /
 * `seedRoostWithVersionHistory` populate them. Idempotent via merge.
 */
export async function seedRoost(
  siteId: string,
  roostId: string,
  opts: SeedRoostOptions = {},
): Promise<void> {
  const db = getAdminDb();
  const extractPathField =
    typeof opts.extractPath === 'string' ? { extractPath: opts.extractPath } : {};

  await db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .set(
      {
        schemaVersion: 2,
        name: opts.name ?? roostId,
        targets: opts.targets ?? [],
        versionCounter: opts.versionCounter ?? 0,
        currentVersionId: null,
        previousVersionId: null,
        deletedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: 'e2e-seed',
        ...extractPathField,
      },
      { merge: true },
    );
}

export interface SeedVersionFile {
  path: string;
  size: number;
  chunks: Array<{ hash: string; size: number }>;
}

export interface SeedVersionOptions {
  versionId: string;
  versionNumber: number;
  description?: string | null;
  files?: SeedVersionFile[];
  /** Override createdAt (ms since epoch). Defaults to now. */
  createdAt?: number;
  /** Optional parent version id (for history chains). */
  parentVersionId?: string | null;
}

/**
 * Version doc only. Does NOT touch the roost's currentVersionId — use
 * `seedRoostWithVersionHistory` for the full happy path. Idempotent.
 */
export async function seedVersion(
  siteId: string,
  roostId: string,
  opts: SeedVersionOptions,
): Promise<void> {
  const db = getAdminDb();
  const files = opts.files ?? [];
  const totalSize =
    files.length > 0 ? files.reduce((n, f) => n + f.size, 0) : 1024;
  const totalFiles = files.length > 0 ? files.length : 1;

  await db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .collection('versions')
    .doc(opts.versionId)
    .set(
      {
        versionId: opts.versionId,
        versionNumber: opts.versionNumber,
        description: opts.description ?? null,
        versionUrl: `https://e2e-seed.test/version-${opts.versionId}.json`,
        createdAt: new Date(opts.createdAt ?? Date.now()),
        createdBy: 'e2e-seed',
        totalSize,
        totalFiles,
        parentVersionId: opts.parentVersionId ?? null,
      },
      { merge: true },
    );
}

export interface SeedRoostWithVersionHistoryOptions {
  /** Display name. Defaults to the roostId. */
  name?: string;
  /** Machine ids this roost deploys to. Defaults to []. */
  targets?: string[];
  /** Optional extract path on the agent side. */
  extractPath?: string;
  /** How many versions to create. Versions number 1..N. */
  versionCount: number;
  /**
   * Per-version descriptions; index N-1 is the description for version #N.
   * Missing entries default to null.
   */
  descriptions?: Array<string | null>;
}

/**
 * Roost + N versions, with the roost's pointers aimed at the head — the state
 * of a roost pushed `versionCount` times.
 */
export async function seedRoostWithVersionHistory(
  siteId: string,
  roostId: string,
  opts: SeedRoostWithVersionHistoryOptions,
): Promise<void> {
  if (!Number.isInteger(opts.versionCount) || opts.versionCount < 1) {
    throw new Error(
      `seedRoostWithVersionHistory: versionCount must be a positive integer (got ${opts.versionCount})`,
    );
  }

  await seedRoost(siteId, roostId, {
    name: opts.name,
    targets: opts.targets,
    extractPath: opts.extractPath,
    versionCounter: 0,
  });

  const versionIdFor = (n: number) => `vrs_${roostId}_v${n}`;

  // Ascending so parentVersionId chains and createdAt order match publish order.
  const baseTime = Date.now() - opts.versionCount * 1000;
  for (let n = 1; n <= opts.versionCount; n++) {
    await seedVersion(siteId, roostId, {
      versionId: versionIdFor(n),
      versionNumber: n,
      description: opts.descriptions?.[n - 1] ?? null,
      createdAt: baseTime + n * 1000,
      parentVersionId: n > 1 ? versionIdFor(n - 1) : null,
    });
  }

  const headNumber = opts.versionCount;
  const headId = versionIdFor(headNumber);
  const previousId = headNumber > 1 ? versionIdFor(headNumber - 1) : null;
  const headDescription = opts.descriptions?.[headNumber - 1] ?? null;

  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .set(
      {
        versionCounter: headNumber,
        currentVersionId: headId,
        previousVersionId: previousId,
        currentVersionNumber: headNumber,
        currentVersionDescription: headDescription,
        versionUrl: `https://e2e-seed.test/version-${headId}.json`,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/**
 * `siteChunks/{digest}` docs so version finalisation's chunk-presence check
 * sees the hashes as already uploaded. Minimum surface a `hasChunk()` needs.
 */
export async function seedChunks(siteId: string, digests: string[]): Promise<void> {
  if (digests.length === 0) return;
  const db = getAdminDb();
  await Promise.all(
    digests.map((digest) =>
      db
        .collection('siteChunks')
        .doc(digest)
        .set(
          {
            siteId,
            hash: digest,
            size: 4096,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
    ),
  );
}
