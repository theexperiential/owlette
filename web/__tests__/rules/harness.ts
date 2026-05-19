/**
 * @jest-environment node
 *
 * Firestore rules test harness.
 *
 * Boots a `@firebase/rules-unit-testing` environment against the running
 * Firestore emulator and exposes role-shaped helpers so individual rule
 * specs don't have to repeat the auth-context boilerplate.
 *
 * Helpers:
 *   - `asUser(uid, role, sites)`   — authenticated user. Mirrors the
 *                                    `users/{uid}` doc that the rules read
 *                                    via `canAccessSite()` / `isSiteAdmin()`,
 *                                    so the harness also seeds that doc
 *                                    (with rules disabled) for you.
 *   - `asAgent(siteId, machineId)` — OAuth agent context. Custom claims
 *                                    match what the rules' `isAgent()` /
 *                                    `agentCanAccessMachine()` helpers expect:
 *                                    `{ role: 'agent', site_id, machine_id }`.
 *                                    Claim names are snake_case (see top of
 *                                    `firestore.rules`).
 *   - `asUnauthenticated()`        — no Auth token at all.
 *
 * Lifecycle:
 *   - call `initRulesHarness()` once in `beforeAll`
 *   - call `clearFirestoreData()` between tests if you need a fresh slate
 *   - call `seedAsAdmin()` to write fixture data with rules disabled
 *   - call `cleanupRulesHarness()` in `afterAll` to close emulator sockets
 *
 * Designed for use by `baseline.test.ts` (this wave) and the denial /
 * tightened-rules suites in waves 6 + 7.
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
 * Initialise the shared rules-test environment. Loads `firestore.rules`
 * from the repo root and points the SDK at the local Firestore emulator.
 *
 * Safe to call once in `beforeAll`. Throws if the emulator isn't reachable
 * — in CI/local that's surfaced via the `npm run test:rules` wrapper which
 * boots the emulator before jest.
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

/**
 * Tear down the rules-test environment. Call from `afterAll`.
 */
export async function cleanupRulesHarness(): Promise<void> {
  if (!env) return;
  await env.cleanup();
  env = null;
}

/**
 * Wipe all Firestore data for the harness project between tests. Does NOT
 * touch security rules or auth contexts.
 */
export async function clearFirestoreData(): Promise<void> {
  if (!env) {
    throw new Error('clearFirestoreData() called before initRulesHarness()');
  }
  await env.clearFirestore();
}

/**
 * Run a callback with rules disabled — for seeding fixture data that the
 * rules wouldn't otherwise let any client write (e.g., site owner field,
 * users/{uid} role, agent_refresh_tokens).
 *
 * The callback receives a privileged Firestore instance.
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
 * Authenticated user context. Also seeds `users/{uid}` so the rule helpers
 * (`canAccessSite`, `isSiteAdmin`, `isSuperadmin`) can resolve role + sites
 * without each test having to remember.
 *
 * Returns the modular Firestore instance bound to that user's auth.
 */
export async function asUser(
  uid: string,
  role: UserRole,
  sites: string[],
): Promise<Firestore> {
  if (!env) {
    throw new Error('asUser() called before initRulesHarness()');
  }

  // Seed (or refresh) the users/{uid} doc with rules disabled so role-aware
  // helpers in firestore.rules can resolve this user's role/sites.
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
 * OAuth agent context. The rules' `isAgent()` helper looks at three custom
 * claims: `role: 'agent'`, `site_id`, `machine_id` (snake_case — see top
 * of firestore.rules). The agent's auth uid is irrelevant for rules, but
 * we use a deterministic `agent-{machineId}` so failed-test logs identify
 * which agent triggered the deny.
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

/**
 * Unauthenticated context — no Auth token. Used for testing public-read
 * paths (installer_metadata) and the global deny-all fallthrough.
 */
export function asUnauthenticated(): Firestore {
  if (!env) {
    throw new Error('asUnauthenticated() called before initRulesHarness()');
  }
  return env.unauthenticatedContext().firestore() as unknown as Firestore;
}
