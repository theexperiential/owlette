/**
 * @jest-environment node
 *
 * Firestore rules baseline test suite.
 *
 * Establishes the GREEN baseline for paths that remain allowed after
 * security-boundary-migration wave 7: reads, agent writes, and user-owned
 * preference writes. Browser control-plane writes live in `denials.test.ts`.
 */

import { assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import {
  initRulesHarness,
  cleanupRulesHarness,
  clearFirestoreData,
  seedAsAdmin,
  asUser,
  asAgent,
  asUnauthenticated,
} from './harness';

const SITE_A = 'site-A';
const SITE_B = 'site-B';
const MACHINE_X = 'machine-X';

const MEMBER_UID = 'member-uid';
const ADMIN_UID = 'admin-uid';
const SUPER_UID = 'super-uid';

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  // Baseline fixture: two sites owned by a third party (so members can only
  // reach them via their users/{uid}.sites assignment). Machine X belongs
  // to site A.
  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', SITE_A), {
      owner: 'someone-else',
      name: 'Site A',
    });
    await setDoc(doc(db, 'sites', SITE_B), {
      owner: 'someone-else',
      name: 'Site B',
    });
    await setDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X), {
      online: true,
      lastHeartbeat: Date.now(),
      configChangeFlag: false,
    });
    await setDoc(doc(db, 'config', SITE_A, 'machines', MACHINE_X), {
      processes: [],
    });
    await setDoc(doc(db, 'installer_metadata', 'latest'), {
      version: '2.11.0',
    });
    await setDoc(doc(db, 'sites', SITE_A, 'audit_log', 'entry-1'), {
      correlationId: 'corr-1',
      actor: { type: 'user', userId: ADMIN_UID, role: 'admin' },
      capability: 'MACHINE_CONFIG_WRITE',
      target: { kind: 'machine', id: MACHINE_X },
      outcome: 'allow',
      timestamp: Date.now(),
    });
  });
});

// ------------------------------------------------------------
// User reads on authorised sites
// ------------------------------------------------------------

describe('user reads', () => {
  test('member reads site they are assigned to', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('admin reads site they are assigned to', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('superadmin reads any site (god-mode fall-through)', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_B)));
  });

  test('member reads machine in their site', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      getDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X)),
    );
  });

  test('member reads machine config in their site', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      getDoc(doc(db, 'config', SITE_A, 'machines', MACHINE_X)),
    );
  });

  test('site admin reads audit log in their site', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);
    await assertSucceeds(
      getDoc(doc(db, 'sites', SITE_A, 'audit_log', 'entry-1')),
    );
  });

  test('superadmin reads audit log globally', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);
    await assertSucceeds(
      getDoc(doc(db, 'sites', SITE_A, 'audit_log', 'entry-1')),
    );
  });
});

// ------------------------------------------------------------
// Agent reads/writes on its own site + machine
// ------------------------------------------------------------

describe('agent reads + writes', () => {
  test('agent reads its own machine doc', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      getDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X)),
    );
  });

  test('agent writes heartbeat/metrics on its own machine', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X),
        {
          online: true,
          lastHeartbeat: Date.now(),
          metrics: { cpu: 12.5, mem: 4096 },
        },
        { merge: true },
      ),
    );
  });

  test('agent reads its own machine config', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      getDoc(doc(db, 'config', SITE_A, 'machines', MACHINE_X)),
    );
  });

  test('agent writes hardware profile for its own machine', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'hardware', 'profile'),
        {
          cpu: 'AMD Ryzen 9 7950X',
          ram_gb: 64,
          gpu: 'RTX 4090',
        },
      ),
    );
  });

  test('agent writes installed_software inventory for its own machine', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(
        doc(
          db,
          'sites',
          SITE_A,
          'machines',
          MACHINE_X,
          'installed_software',
          'sw-1',
        ),
        {
          name: 'TouchDesigner',
          version: '2023.11290',
        },
      ),
    );
  });

  test('agent writes a log entry for its own machine', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(doc(db, 'sites', SITE_A, 'logs', 'log-1'), {
        timestamp: Date.now(),
        action: 'process_started',
        level: 'info',
        machineId: MACHINE_X,
      }),
    );
  });

  test('agent writes its target_state under a roost', async () => {
    // The roosts/{roostId} parent must exist; seed it with rules disabled
    // (creating a roost requires fields we don't care about here).
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        name: 'kiosk-bundle',
        targets: [MACHINE_X],
        createdAt: Date.now(),
        schemaVersion: 2,
        currentManifestId: null,
      });
    });

    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(
        doc(
          db,
          'sites',
          SITE_A,
          'roosts',
          'roost-1',
          'target_state',
          MACHINE_X,
        ),
        {
          observedManifestId: 'manifest-abc',
          reportedAt: Date.now(),
        },
      ),
    );
  });
});

// ------------------------------------------------------------
// Unauthenticated access — public reads + global denies
// ------------------------------------------------------------

describe('unauthenticated', () => {
  test('reads installer_metadata (public download path)', async () => {
    const db = asUnauthenticated();
    await assertSucceeds(getDoc(doc(db, 'installer_metadata', 'latest')));
  });
});

// ------------------------------------------------------------
// User self-write — own users/{uid} doc with role/email/sites preserved
// ------------------------------------------------------------

describe('user self-writes', () => {
  test('member updates own user doc preserving role/email/sites', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'users', MEMBER_UID), {
        uid: MEMBER_UID,
        email: `${MEMBER_UID}@harness.test`,
        role: 'member',
        sites: [SITE_A],
        displayName: 'Updated Name',
      }),
    );
  });

  test('member writes own device preferences', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'users', MEMBER_UID, 'devicePrefs', 'browser'), {
        viewMode: 'grid',
      }),
    );
  });

  test('member writes own settings doc', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'users', MEMBER_UID, 'settings', 'llm'), {
        provider: 'anthropic',
      }),
    );
  });
});
