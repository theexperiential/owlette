/**
 * @jest-environment node
 *
 * Firestore rules baseline test suite.
 *
 * Establishes the GREEN baseline against the current `firestore.rules`
 * before the security-boundary-migration tightens specific paths in
 * waves 6 + 7. Every assertion in this file is currently allowed and
 * MUST stay green so we know the harness + rules are wired up correctly.
 *
 * Denial tests (currently-disallowed operations) live in
 * `denials.test.ts` (wave 6). Tightened-rules tests (operations that
 * become disallowed after the migration) also live in wave 6 / 7.
 */

import { assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
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
});

// ------------------------------------------------------------
// User writes on currently-permissive paths
// (deployments, machine config, configChangeFlag, presets)
// ------------------------------------------------------------

describe('user writes (currently permissive)', () => {
  test('member creates a deployment in their site', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-1'), {
        name: 'Test Deployment',
        installer_name: 'TouchDesigner.exe',
        targets: [MACHINE_X],
        status: 'pending',
        createdAt: serverTimestamp(),
      }),
    );
  });

  test('member writes machine config (config/{siteId}/machines/{machineId})', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'config', SITE_A, 'machines', MACHINE_X), {
        processes: [{ name: 'TouchDesigner', path: 'C:\\TD.exe' }],
      }),
    );
  });

  test('member toggles configChangeFlag on a machine', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      updateDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X), {
        configChangeFlag: true,
      }),
    );
  });

  test('member writes a pending command for a machine', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'commands', 'pending'),
        {
          'cmd-1': {
            type: 'restart_process',
            status: 'pending',
            createdAt: Date.now(),
          },
        },
      ),
    );
  });

  test('member creates a schedule preset in their site', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'config', SITE_A, 'schedule_presets', 'preset-1'), {
        name: 'Daily 9am',
        cron: '0 9 * * *',
      }),
    );
  });

  test('site admin writes a webhook on their site', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'sites', SITE_A, 'webhooks', 'wh-1'), {
        url: 'https://example.com/hook',
        events: ['process.crashed'],
      }),
    );
  });

  test('site admin writes site settings on their site', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);
    await assertSucceeds(
      setDoc(doc(db, 'sites', SITE_A, 'settings', 'llm'), {
        provider: 'anthropic',
      }),
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

// ------------------------------------------------------------
// Site members can delete things they own (cleanup paths)
// ------------------------------------------------------------

describe('site member deletes', () => {
  test('member deletes a deployment in their site', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-old'), {
        name: 'Old Deployment',
        installer_name: 'foo.exe',
        targets: [],
        status: 'completed',
        createdAt: Date.now(),
      });
    });
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);
    await assertSucceeds(
      deleteDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-old')),
    );
  });
});
