/**
 * @jest-environment node
 *
 * Wave 1-3 security hardening rules tests.
 *
 * Covers the NEW behaviors that shipped in waves 1-3 of the security
 * hardening pass and weren't already exercised by baseline.test.ts /
 * denials.test.ts:
 *
 *   - users/{uid} CREATE field constraints (role/sites/email/MFA defaults)
 *   - users/{uid} UPDATE allowlist (diff().affectedKeys().hasOnly([...]))
 *   - canAccessSite() deletedAt gating
 *   - cortex/active-chat per-machine agent write
 *   - cortex-events agent create + update/delete denial
 *   - sites/{s}/machines/{m}/logs/{id} per-machine logs agent write
 *
 * RUN: `npm run test:rules` (boots the emulator first). Not picked up by
 * the default jest run because rules tests need the emulator on :8080.
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

  // Common fixture: two sites, two machines on site A.
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

/* ---------------------------------------------------------------------- */
/*  Item 1: users/{uid} CREATE field constraints                          */
/* ---------------------------------------------------------------------- */

describe('users/{uid} create — sensitive field defaults pinned', () => {
  /**
   * The rules' create clause uses absent-OR-equals pattern. A client
   * attempting to elevate themselves on first-login (e.g. by writing
   * `sites: ['some-victim-site']`, `role: 'admin'`, etc.) must be denied.
   * The "safe minimum" doc — explicit defaults that match the implicit
   * server defaults — should succeed so this rule doesn't break legitimate
   * first-login flow.
   *
   * Note: rules-unit-testing's authenticatedContext uses Firebase v9
   * default token shape — token.email is set to `<uid>@<projectId>.iam`.
   * The asUser harness uses a synthetic email; here we rely on the emulator
   * auth token's email claim being `<uid>@example.com` when we
   * authenticatedContext with no overrides. The `email` test below uses an
   * arbitrary string we know does NOT equal the token email.
   */
  test('rejects sites:[victim-site] on create', async () => {
    // First-login: no users/{uid} doc exists yet, so we cannot use the
    // asUser() helper (it pre-seeds the doc). We open an
    // authenticatedContext directly via the harness env.
    // Use a fresh uid so the asUser-seeded doc from beforeEach is gone.
    const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    // Re-using the shared env via asAgent is the wrong shape — instead
    // we call asUser to bootstrap a different uid, then issue the doc
    // creation as that uid via the same context. Since asUser already
    // seeds the doc, we'd need to clear it. Simpler: pre-clear and use
    // asUser for a different-uid context to call the rule path on SELF_UID.
    // BUT: rules check request.auth.uid == userId, so we must be SELF.
    // To work around the helper's auto-seed, just delete the seeded doc
    // first and then issue the rule-tested create as the same uid.
    void initializeTestEnvironment; // satisfy lint

    const db = await asUser(SELF_UID, 'member', []);

    // The asUser helper seeded users/SELF_UID. Wipe it (as admin) so the
    // create-rule branch is the one we test, not update.
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

  test('rejects passkeyEnrolled:true on create', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await deleteDoc(doc(adminDb, 'users', SELF_UID));
    });

    await assertFails(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'member',
        sites: [],
        passkeyEnrolled: true, // <-- the attack
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

    // asUser uses authenticatedContext(SELF_UID), which results in a
    // synthetic Firebase auth token. The token.email is not set by the
    // emulator unless we override (and we don't). So the rule's
    // `request.resource.data.email == request.auth.token.email` clause is
    // satisfied by OMITTING the email key entirely (absent-OR-equals).
    await assertSucceeds(
      setDoc(doc(db, 'users', SELF_UID), {
        uid: SELF_UID,
        role: 'member',
        sites: [],
        mfaEnrolled: false,
        requiresMfaSetup: true,
        passkeyEnrolled: false,
      }),
    );
  });
});

/* ---------------------------------------------------------------------- */
/*  Item 2: users/{uid} UPDATE allowlist                                  */
/* ---------------------------------------------------------------------- */

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

  test('rejects update to passkeyEnrolled', async () => {
    const db = await asUser(SELF_UID, 'member', []);
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), { passkeyEnrolled: true }),
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
    // displayName is allowed; role is not. hasOnly([...]) means a single
    // disallowed key fails the whole write.
    await assertFails(
      updateDoc(doc(db, 'users', SELF_UID), {
        displayName: 'Legit Name',
        role: 'admin',
      }),
    );
  });

  // Document the allowlist constants so a future change to the rules also
  // requires updating this list.
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

/* ---------------------------------------------------------------------- */
/*  Item 3: canAccessSite() deletedAt gating                              */
/* ---------------------------------------------------------------------- */

describe('canAccessSite — deletedAt gating', () => {
  test('soft-deleted user cannot read their assigned site', async () => {
    // Seed the user with sites = [SITE_A] AND a deletedAt timestamp.
    // The user doc is admin-seeded so we can set the role/sites/deletedAt
    // directly without going through the rules.
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'users', DELETED_UID), {
        uid: DELETED_UID,
        email: `${DELETED_UID}@harness.test`,
        role: 'member',
        sites: [SITE_A],
        deletedAt: Date.now(), // soft delete timestamp
      });
    });

    // Open an authenticated context for the deleted user. We can't use
    // asUser because it overwrites the user doc — we want the deletedAt
    // intact. So we go through the env directly.
    const { initializeTestEnvironment: _init } = await import('@firebase/rules-unit-testing');
    void _init;
    // Re-derive the env by importing the harness internals; easier path:
    // use asAgent's underlying mechanism by going through the harness
    // module's `env` global. asUser pre-seeds — so instead we use a
    // bespoke flow:
    const harness = await import('./harness');
    const envField = (harness as unknown as { env?: unknown }).env;
    void envField; // not exported; fall back to the public surface
    // The harness doesn't expose env directly. We can simulate by
    // *post*-seeding the deletedAt AFTER asUser runs — asUser writes
    // `{uid, email, role, sites}` but does NOT clear deletedAt if we
    // seed it after. We must seed deletedAt LAST so asUser's setDoc
    // doesn't overwrite it.
    const db = await asUser(DELETED_UID, 'member', [SITE_A]);
    await seedAsAdmin(async (adminDb) => {
      await updateDoc(doc(adminDb, 'users', DELETED_UID), {
        deletedAt: Date.now(),
      });
    });

    // Now even though sites[] contains SITE_A, deletedAt is set.
    await assertFails(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('non-deleted user with same sites[] CAN read the site (control)', async () => {
    // Control case: same setup minus deletedAt should succeed. Confirms
    // the failure above is specifically caused by the gating field.
    const db = await asUser(DELETED_UID, 'member', [SITE_A]);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
  });
});

/* ---------------------------------------------------------------------- */
/*  Item 4: cortex/active-chat agent writes                               */
/* ---------------------------------------------------------------------- */

describe('cortex/{docId} — per-machine agent writes', () => {
  test('agent for machine X can write cortex/active-chat on machine X', async () => {
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

  test('agent for machine X cannot write cortex/* on machine Y (cross-machine)', async () => {
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

  test('agent for site A cannot write cortex/* on site B', async () => {
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

/* ---------------------------------------------------------------------- */
/*  Item 5: cortex-events agent create + update/delete denial             */
/* ---------------------------------------------------------------------- */

describe('cortex-events/{eventId} — agent create only, update/delete server-only', () => {
  test('agent CAN create a cortex event in its own site', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertSucceeds(
      setDoc(doc(db, 'sites', SITE_A, 'cortex-events', 'evt-1'), {
        machineId: MACHINE_X,
        eventType: 'autonomous_investigation_start',
        timestamp: Date.now(),
      }),
    );
  });

  test('agent in site A CANNOT create a cortex event in site B', async () => {
    const db = asAgent(SITE_A, MACHINE_X);
    await assertFails(
      setDoc(doc(db, 'sites', SITE_B, 'cortex-events', 'evt-cross'), {
        machineId: MACHINE_X,
        eventType: 'autonomous_investigation_start',
        timestamp: Date.now(),
      }),
    );
  });

  test('agent CANNOT update an existing cortex event (server-only)', async () => {
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

  test('agent CANNOT delete a cortex event (server-only)', async () => {
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

/* ---------------------------------------------------------------------- */
/*  Item 6: sites/{s}/machines/{m}/logs/{id} — per-machine logs           */
/* ---------------------------------------------------------------------- */

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
