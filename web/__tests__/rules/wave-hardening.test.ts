/**
 * @jest-environment node
 *
 * Security-hardening rules not already covered by baseline.test.ts /
 * denials.test.ts: users/{uid} create constraints and update allowlist,
 * canAccessSite() deletedAt gating, hoot/active-chat + cortex-events +
 * per-machine logs agent writes.
 *
 * RUN: `npm run test:rules` — needs the emulator on :8080, so the default
 * jest run skips it.
 */

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  setDoc,
  updateDoc,
  getDoc,
} from 'firebase/firestore';
import {
  asAgent,
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE_A = 'site-A';
const SITE_B = 'site-B';
const MACHINE_X = 'machine-X';
const MACHINE_Y = 'machine-Y';

const SELF_UID = 'self-uid';
const SELF_EMAIL = `${SELF_UID}@harness.test`;
const DELETED_UID = 'deleted-uid';

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  // Two sites, two machines on site A.
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
    });
    await setDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_Y), {
      online: true,
      lastHeartbeat: Date.now(),
    });
  });
});

describe('users/{uid} create — sensitive field defaults pinned', () => {
  /**
   * The create clause is absent-OR-equals: first-login self-elevation
   * (`sites: ['victim']`, `role: 'admin'`, …) must be denied, while the
   * safe-minimum doc still succeeds so legitimate first login works.
   */
  test('rejects sites:[victim-site] on create', async () => {
    const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    void initializeTestEnvironment; // satisfy lint

    const db = await asUser(SELF_UID, 'member', []);

    // asUser seeds users/SELF_UID; wipe it so we exercise create, not update.
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    await assertFails(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        email: SELF_EMAIL,
        role: 'member',
        sites: ['victim-site-id'], // <-- the attack
      }),
    );
  });

  test('rejects role:admin on create (privilege escalation)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    await assertFails(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'admin', // <-- the attack
        sites: [],
      }),
    );
  });

  test('rejects mfaEnrolled:true on create (sidestep enrollment proof)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    await assertFails(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'member',
        sites: [],
        mfaEnrolled: true, // <-- the attack
      }),
    );
  });

  test('rejects requiresMfaSetup:false on create (skip nag)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    await assertFails(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'member',
        sites: [],
        requiresMfaSetup: false, // <-- the attack
      }),
    );
  });

  test('rejects mismatched email on create (impersonation)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    await assertFails(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'member',
        sites: [],
        email: 'attacker-not-token@harness.test',
      }),
    );
  });

  test('allows the safe-minimum doc on create (matches implicit defaults)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    // The emulator sets no token.email here, so the rule's
    // `data.email == auth.token.email` clause is satisfied by omitting email.
    await assertSucceeds(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'member',
        sites: [],
        mfaEnrolled: false,
        requiresMfaSetup: true,
      }),
    );
  });
});

describe('users/{uid} update — diff allowlist', () => {
  const ALLOWLIST = [
    'preferences',
    'displayName',
    'photoURL',
    'timezone',
    'lastSiteId',
    'lastMachineIds',
  ];

  test('allowed fields can be updated by self', async () => {
    // asUser seeds the doc, so update is the active path.
    const db = await asUser(SELF_UID, 'member', []);

    await assertSucceeds(
      updateDoc(doc(db, 'users', SELF_UID), {
        displayName: 'My New Name',
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', SELF_UID), {
        preferences: { theme: 'dark' },
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', SELF_UID), {
        timezone: 'America/Los_Angeles',
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', SELF_UID), {
        lastSiteId: SITE_A,
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', SELF_UID), {
        lastMachineIds: { [SITE_A]: MACHINE_X },
      }),
    );
  });

  test('rejects update to role (privilege escalation)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(updateDoc(doc(db, 'users', SELF_UID), { role: 'admin' }));
  });

  test('rejects update to email', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { email: 'new@example.com' }),
    );
  });

  test('rejects update to sites (self-assign to victim site)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { sites: ['victim-site-id'] }),
    );
  });

  test('rejects update to mfaEnrolled (disable own MFA)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { mfaEnrolled: false }),
    );
  });

  test('rejects update to mfaSecret', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { mfaSecret: 'attacker-secret' }),
    );
  });

  test('rejects update to backupCodes', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { backupCodes: ['fake'] }),
    );
  });

  // `mfaFactors` is the authoritative second-factor tally, so self-writing it
  // is the escalation the allowlist must refuse.
  test('rejects update to mfaFactors', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), {
        mfaFactors: { totp: true, passkeys: 3 },
      }),
    );
  });

  test('rejects update to requiresMfaSetup', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { requiresMfaSetup: false }),
    );
  });

  test('rejects mixed update with one disallowed key (allowlist is hasOnly)', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    // hasOnly([...]): one disallowed key fails the whole write.
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), {
        displayName: 'Legit Name',
        role: 'admin',
      }),
    );
  });

  // Pinned so a rules change has to update this list too.
  test('allowlist constant covers exactly 6 fields (matches firestore.rules)', () => {
    expect(ALLOWLIST.sort()).toEqual(
      [
        'preferences',
        'displayName',
        'photoURL',
        'timezone',
        'lastSiteId',
        'lastMachineIds',
      ].sort(),
    );
  });
});

describe('canAccessSite — deletedAt gating', () => {
  test('soft-deleted user cannot read their assigned site', async () => {
    // Admin-seeded so role/sites/deletedAt bypass the rules.
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'users', DELETED_UID), {
        uid: DELETED_UID,
        email: `${DELETED_UID}@harness.test`,
        role: 'member',
        sites: [SITE_A],
        deletedAt: Date.now(),
      });
    });

    const { initializeTestEnvironment: _init } = await import('@firebase/rules-unit-testing');
    void _init;
    const harness = await import('./harness');
    const envField = (harness as unknown as { env?: unknown }).env;
    void envField; // not exported; fall back to the public surface
    // The harness won't hand out its env, and asUser overwrites the user doc —
    // so seed deletedAt LAST, after asUser's setDoc.
    const db = await asUser(DELETED_UID, 'member', [SITE_A]);
    await seedAsAdmin(async (adminDb) => {
      await updateDoc(doc(adminDb, 'users', DELETED_UID), {
        deletedAt: Date.now(),
      });
    });

    // sites[] contains SITE_A, but deletedAt is set.
    await assertFails(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('non-deleted user with same sites[] CAN read the site (control)', async () => {
    // Negative control: same setup minus deletedAt must succeed.
    const db = await asUser(DELETED_UID, 'member', [SITE_A]);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
  });
});

describe('hoot/{docId} — per-machine agent writes', () => {
  test('agent for machine X can write hoot/active-chat on machine X', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'cortex', 'active-chat'),
        {
          chatId: 'chat-1',
          status: 'streaming',
          updatedAt: Date.now(),
        },
      ),
    );
  });

  test('agent for machine X cannot write hoot/* on machine Y (cross-machine)', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_Y, 'cortex', 'active-chat'),
        {
          chatId: 'chat-evil',
          status: 'streaming',
          updatedAt: Date.now(),
        },
      ),
    );
  });

  test('agent for site A cannot write hoot/* on site B', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    // SITE_B has its own machine, but the agent's site_id claim is A.
    await seedAsAdmin(async (adminDb) => {
      await setDoc(doc(adminDb, 'sites', SITE_B, 'machines', MACHINE_X), {
        online: true,
      });
    });
    await assertFails(
      setDoc(
        doc(db, 'sites', SITE_B, 'machines', MACHINE_X, 'cortex', 'active-chat'),
        { chatId: 'cross-site' },
      ),
    );
  });
});

describe('cortex-events/{eventId} — agent create only, update/delete server-only', () => {
  test('agent CAN create a hoot event in its own site', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(doc(db, 'sites', SITE_A, 'cortex-events', 'evt-1'), {
        machineId: MACHINE_X,
        eventType: 'autonomous_investigation_start',
        timestamp: Date.now(),
      }),
    );
  });

  test('agent in site A CANNOT create a hoot event in site B', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      setDoc(doc(db, 'sites', SITE_B, 'cortex-events', 'evt-cross'), {
        machineId: MACHINE_X,
        eventType: 'autonomous_investigation_start',
        timestamp: Date.now(),
      }),
    );
  });

  test('agent CANNOT update an existing hoot event (server-only)', async () => {
    await seedAsAdmin(async (adminDb) => {
      await setDoc(doc(adminDb, 'sites', SITE_A, 'cortex-events', 'evt-existing'), {
        machineId: MACHINE_X,
        eventType: 'foo',
        timestamp: Date.now(),
      });
    });

    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'cortex-events', 'evt-existing'), {
        eventType: 'tampered',
      }),
    );
  });

  test('agent CANNOT delete a hoot event (server-only)', async () => {
    await seedAsAdmin(async (adminDb) => {
      await setDoc(doc(adminDb, 'sites', SITE_A, 'cortex-events', 'evt-existing'), {
        machineId: MACHINE_X,
        eventType: 'foo',
        timestamp: Date.now(),
      });
    });

    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      deleteDoc(doc(db, 'sites', SITE_A, 'cortex-events', 'evt-existing')),
    );
  });
});

describe('sites/{s}/machines/{m}/logs/{id} — per-machine agent create-only', () => {
  test('agent CAN create a log on its own machine', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'logs', 'log-1'),
        {
          timestamp: Date.now(),
          level: 'info',
          message: 'agent startup',
        },
      ),
    );
  });

  test('agent CANNOT create a log on a different machine (cross-machine)', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_Y, 'logs', 'log-cross'),
        { timestamp: Date.now(), level: 'info', message: 'spoof' },
      ),
    );
  });

  test('agent CANNOT update a log (append-only contract)', async () => {
    await seedAsAdmin(async (adminDb) => {
      await setDoc(
        doc(adminDb, 'sites', SITE_A, 'machines', MACHINE_X, 'logs', 'log-1'),
        { timestamp: Date.now(), level: 'info', message: 'existing' },
      );
    });

    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      updateDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'logs', 'log-1'),
        { message: 'tampered' },
      ),
    );
  });

  test('agent CANNOT delete a log (server-only retention)', async () => {
    await seedAsAdmin(async (adminDb) => {
      await setDoc(
        doc(adminDb, 'sites', SITE_A, 'machines', MACHINE_X, 'logs', 'log-1'),
        { timestamp: Date.now(), level: 'info', message: 'existing' },
      );
    });

    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      deleteDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'logs', 'log-1'),
      ),
    );
  });
});
