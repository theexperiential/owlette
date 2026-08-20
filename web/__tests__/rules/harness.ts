/**
 * @jest-environment node
 *
 * Firestore rules test harness — boots `@firebase/rules-unit-testing` against
 * the running emulator and exposes role-shaped auth contexts so rule specs
 * skip the boilerplate.
 *
 * Lifecycle: `initRulesHarness()` in `beforeAll`, `clearFirestoreData()`
 * between tests, `seedAsAdmin()` to write fixtures with rules disabled,
 * `cleanupRulesHarness()` in `afterAll` to close emulator sockets.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { Firestore } from 'firebase/firestore';

/** Roles recognised by `firestore.rules` users/{uid}.role. */
export type UserRole = 'member' | 'admin' | 'superadmin';

const PROJECT_ID = 'demo-rules-harness';

// Emulator host/port comes from firebase.json — keep in sync.
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8080;

let env: RulesTestEnvironment | null = null;

/**
 * Load `firestore.rules` from the repo root and point the SDK at the local
 * emulator. Throws if the emulator isn't up — `npm run test:rules` boots it.
 */
export async function initRulesHarness(): Promise<RulesTestEnvironment> {
  if (env) return env;

  // firestore.rules lives at the repo root, two directories up from web/.
  const rulesPath = join(__dirname, '..', '..', '..', 'firestore.rules');
  const rules = readFileSync(rulesPath, 'utf8');

  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: FIRESTORE_HOST,
      port: FIRESTORE_PORT,
    },
  });

  return env;
}

/** Tear down the rules-test environment. Call from `afterAll`. */
export async function cleanupRulesHarness(): Promise<void> {
  if (!env) return;
  await env.cleanup();
  env = null;
}

/** Wipe harness Firestore data. Leaves rules and auth contexts alone. */
export async function clearFirestoreData(): Promise<void> {
  if (!env) {
    throw new Error('clearFirestoreData() called before initRulesHarness()');
  }
  await env.clearFirestore();
}

/**
 * Run `fn` with a privileged Firestore instance (rules disabled), for fixtures
 * no client may write: site owner, `users/{uid}.role`, agent_refresh_tokens.
 */
export async function seedAsAdmin(
  fn: (db: Firestore) => Promise<void>,
): Promise<void> {
  if (!env) {
    throw new Error('seedAsAdmin() called before initRulesHarness()');
  }
  await env.withSecurityRulesDisabled(async (ctx: RulesTestContext) => {
    await fn(ctx.firestore() as unknown as Firestore);
  });
}

/**
 * Authenticated user context, with `users/{uid}` seeded so `canAccessSite` /
 * `isSiteAdmin` / `isSuperadmin` can resolve role + sites.
 */
export async function asUser(
  uid: string,
  role: UserRole,
  sites: string[],
): Promise<Firestore> {
  if (!env) {
    throw new Error('asUser() called before initRulesHarness()');
  }

  // Rules disabled: no client may write users/{uid}.role.
  await seedAsAdmin(async (db) => {
    const { doc, setDoc } = await import('firebase/firestore');
    await setDoc(doc(db, 'users', uid), {
      uid,
      email: `${uid}@harness.test`,
      role,
      sites,
    });
  });

  const ctx = env.authenticatedContext(uid);
  return ctx.firestore() as unknown as Firestore;
}

/**
 * OAuth agent context. `isAgent()` reads three snake_case custom claims:
 * `role: 'agent'`, `site_id`, `machine_id`. The uid is irrelevant to the
 * rules; `agent-{machineId}` just makes failure logs identifiable.
 */
export function asAgent(siteId: string, machineId: string): Firestore {
  if (!env) {
    throw new Error('asAgent() called before initRulesHarness()');
  }

  const ctx = env.authenticatedContext(`agent-${machineId}`, {
    role: 'agent',
    site_id: siteId,
    machine_id: machineId,
  });
  return ctx.firestore() as unknown as Firestore;
}

/** No Auth token — for public-read paths and the global deny-all fallthrough. */
export function asUnauthenticated(): Firestore {
  if (!env) {
    throw new Error('asUnauthenticated() called before initRulesHarness()');
  }
  return env.unauthenticatedContext().firestore() as unknown as Firestore;
}
