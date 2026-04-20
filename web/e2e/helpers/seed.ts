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
