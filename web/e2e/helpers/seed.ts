/**
 * Seed helpers — create deterministic test data in the Firestore + Auth
 * emulators. Called by global-setup; also usable from individual specs
 * when a test needs to tweak the baseline.
 */

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
 * The canonical test-user fleet. Mirrors the convention in scripts/test-rules.mjs.
 * - member-uid is on site-A only
 * - admin-uid is on site-A only (site-admin, not platform superadmin)
 * - super-uid has empty sites[] but gets god-mode via canAccessSite fall-through
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
 * Seed a single user — creates the Firebase Auth account (if missing) and
 * the Firestore users/{uid} doc.
 *
 * MFA is explicitly pre-satisfied (mfaEnrolled=false, requiresMfaSetup=false)
 * so the redirect gates in dashboard/page.tsx + login/page.tsx don't trip
 * the E2E flow.
 */
export async function seedUser(user: TestUser): Promise<void> {
  const auth = getAdminAuth();
  const db = getAdminDb();

  // Create Auth user (idempotent — if already exists, update)
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

  // Seed the Firestore users/{uid} doc with MFA bypassed.
  await db.collection('users').doc(user.uid).set({
    email: user.email,
    role: user.role,
    sites: user.sites,
    displayName: user.displayName ?? '',
    createdAt: new Date(),
    // MFA bypass — avoids the /setup-2fa and /verify-2fa redirect gates.
    mfaEnrolled: false,
    requiresMfaSetup: false,
    passkeyEnrolled: false,
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

/**
 * Seed the entire canonical baseline: three users + two sites. Called by
 * global-setup. Individual specs can extend this by calling seedMachine,
 * seedDeployment, etc. in their own setup.
 */
export async function seedBaseline(): Promise<void> {
  // Sites first — some rules guards reference site docs via get().
  await Promise.all(TEST_SITES.map(seedSite));
  await Promise.all(Object.values(TEST_USERS).map(seedUser));
}

export interface SeedMachineOptions {
  /** Custom display name (defaults to machineId). */
  displayName?: string;
  /**
   * Seconds-to-backdate the `lastHeartbeat` field. Defaults to 0 (now),
   * which renders the machine as online. Pass >180 to simulate a stale
   * heartbeat (offline via the 180s threshold in useMachines).
   */
  heartbeatOffsetSec?: number;
  /**
   * Optional override for the number of monitors in the seeded display
   * profile. Defaults to 2 (primary + secondary). Zero = no display
   * subdoc written (machine card shows "no display data reported").
   */
  monitorCount?: number;
  /**
   * Simulate an in-flight reboot. When set, writes `rebooting: true` +
   * `rebootScheduledAt` (offset seconds into the future) so the
   * MachineStatusPill renders its clickable countdown variant for
   * site-admins and the text-only variant for non-admins. Defaults to
   * undefined (no active reboot).
   */
  rebootingInSec?: number;
  /**
   * Seed a "reboot pending" state — the amber banner on the machine card
   * with approve/dismiss buttons, which the agent writes after a process
   * crashes. Only the card view renders this banner. Pass `true` for a
   * sensible default (`active: true`, generic reason) or an object for
   * full control over the payload.
   */
  rebootPending?:
    | boolean
    | {
        processName?: string;
        reason?: string;
      };
}

/**
 * Seed a machine under `sites/{siteId}/machines/{machineId}` with enough
 * state for the dashboard to render its card AND for the DisplayLayoutPanel
 * to mount with a real display profile when the user clicks the display
 * chart.
 *
 * Writes:
 *   - `sites/{siteId}/machines/{machineId}` — status doc (lastHeartbeat,
 *     online, minimal metrics scaffolding).
 *   - `sites/{siteId}/machines/{machineId}/hardware/display` — the
 *     DisplayProfile that `useDisplayState` subscribes to, with N monitors.
 *
 * The Admin SDK bypasses firestore.rules, so this works regardless of the
 * caller's auth state. Safe to call multiple times — each call overwrites
 * the prior doc.
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

  // Optional reboot state — mirrors the fields the agent writes during an
  // in-flight reboot. Using a future `rebootScheduledAt` (Unix seconds) lights
  // up the countdown path in MachineStatusPill; setting `rebooting: true`
  // keeps the pill in "active" mode even if the clock moves past the target.
  const rebootingExtras =
    typeof opts.rebootingInSec === 'number'
      ? {
          rebooting: true,
          rebootScheduledAt: nowSec + opts.rebootingInSec,
        }
      : {};

  // Optional reboot-pending banner — the agent writes this shape after a
  // process crash triggers the "needs reboot" pathway. Accept either `true`
  // for a sensible default payload or an object to override processName /
  // reason.
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

  // Status doc — the dashboard's useMachines listener materializes this into
  // the machine card. `online` + a fresh `lastHeartbeat` render the green
  // status pill; empty `metrics` keeps the card minimal (no sparkline data
  // required for the display-panel test).
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
      metrics: {
        schemaVersion: 2,
        timestamp: new Date(),
      },
      ...rebootingExtras,
      ...rebootPendingExtras,
    });

  // Display profile — subscribed by useDisplayState. Two dummy monitors at
  // offset positions so the DisplayCanvas has something non-trivial to
  // render. `edidHash` is the identity key used for drift matching; we
  // pick stable synthetic values so re-runs are deterministic.
  if (monitorCount > 0) {
    const monitors = Array.from({ length: monitorCount }, (_, i) => ({
      id: `MONITOR\\TEST${i}`,
      edidHash: `hash-${machineId}-${i}`,
      manufacturerId: 'TST',
      productCode: `000${i}`,
      serialNumber: `SN${i}`,
      friendlyName: `Test Monitor ${i + 1}`,
      position: { x: i * 1920, y: 0 },
      resolution: { width: 1920, height: 1080 },
      refreshHz: 60,
      rotation: 0,
      scalePct: 100,
      primary: i === 0,
      connectionType: 'dp',
      adapterLuid: '0:0',
      targetId: i,
    }));

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
