/**
 * @jest-environment node
 *
 * Firestore rules denial suite for security-boundary-migration wave 7.
 *
 * Each test describes a browser-client control-plane write that must fail
 * after the rules lockdown.
 */

import { assertFails } from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE_A = 'site-A';
const MACHINE_X = 'machine-X';

const MEMBER_UID = 'member-uid';
const ADMIN_UID = 'admin-uid';
const SUPER_UID = 'super-uid';
const TARGET_UID = 'target-uid';

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', SITE_A), {
      owner: 'owner-uid',
      name: 'Site A',
    });
    await setDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X), {
      online: true,
      lastHeartbeat: Date.now(),
      configChangeFlag: false,
      cortexEnabled: true,
    });
    await setDoc(doc(db, 'config', SITE_A, 'machines', MACHINE_X), {
      processes: [
        {
          id: 'proc-1',
          name: 'TouchDesigner',
          path: 'C:\\TouchDesigner\\TouchDesigner.exe',
          launch_mode: 'manual',
        },
      ],
    });
    await setDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-1'), {
      name: 'Deployment',
      installer_name: 'TouchDesigner.exe',
      targets: [MACHINE_X],
      status: 'pending',
      createdAt: Date.now(),
    });
    await setDoc(doc(db, 'sites', SITE_A, 'project_distributions', 'dist-1'), {
      name: 'Distribution',
      file_name: 'show.toe',
      targets: [MACHINE_X],
      status: 'pending',
      createdAt: Date.now(),
    });
    await setDoc(doc(db, 'sites', SITE_A, 'installer_templates', 'template-1'), {
      name: 'Template',
      installer_name: 'TouchDesigner.exe',
      createdAt: Date.now(),
    });
    await setDoc(doc(db, 'sites', SITE_A, 'project_templates', 'project-template-1'), {
      name: 'Project Template',
      file_name: 'show.toe',
      createdAt: Date.now(),
    });
    await setDoc(doc(db, 'sites', SITE_A, 'settings', 'alerts'), {
      rules: [],
    });
    await setDoc(doc(db, 'sites', SITE_A, 'webhooks', 'webhook-1'), {
      name: 'Webhook',
      url: 'https://example.com/hook',
      events: ['process.crashed'],
      enabled: true,
    });
    await setDoc(doc(db, 'sites', SITE_A, 'logs', 'log-1'), {
      timestamp: Date.now(),
      action: 'process_started',
      level: 'info',
      machineId: MACHINE_X,
    });
    await setDoc(doc(db, 'config', SITE_A, 'schedule_presets', 'schedule-1'), {
      name: 'Weekdays',
      cron: '0 9 * * 1-5',
    });
    await setDoc(doc(db, 'config', SITE_A, 'reboot_presets', 'reboot-1'), {
      name: 'Nightly',
      hour: 3,
      minute: 0,
    });
    await setDoc(
      doc(db, 'config', SITE_A, 'project_distribution_presets', 'distribution-preset-1'),
      {
        name: 'All kiosks',
        targets: [MACHINE_X],
      },
    );
    await setDoc(doc(db, 'system_presets', 'system-preset-1'), {
      name: 'TouchDesigner',
      software_name: 'TouchDesigner',
      category: 'creative',
      installer_name: 'TouchDesigner.exe',
      silent_flags: '/S',
      order: 1,
      createdAt: Date.now(),
    });
    await setDoc(doc(db, 'users', TARGET_UID), {
      uid: TARGET_UID,
      email: `${TARGET_UID}@harness.test`,
      role: 'member',
      sites: [],
    });
    await setDoc(doc(db, 'installer_metadata', 'latest'), {
      version: '2.11.0',
    });
  });
});

describe('site-scoped control-plane writes', () => {
  test('member cannot create sites directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', 'site-direct-create'), {
        owner: MEMBER_UID,
        name: 'Direct Create',
      }),
    );
  });

  test('member cannot update site metadata directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A), {
        name: 'Renamed Site',
      }),
    );
  });

  test('member cannot delete a site directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'sites', SITE_A)));
  });

  test('member cannot create deployments directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-direct'), {
        name: 'Direct Deployment',
        installer_name: 'TouchDesigner.exe',
        targets: [MACHINE_X],
        status: 'pending',
        createdAt: serverTimestamp(),
      }),
    );
  });

  test('member cannot update deployments directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-1'), {
        status: 'cancelled',
      }),
    );
  });

  test('member cannot delete deployments directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'sites', SITE_A, 'deployments', 'dep-1')));
  });

  test('member cannot create project distributions directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'project_distributions', 'dist-direct'), {
        name: 'Direct Distribution',
        file_name: 'show.toe',
        targets: [MACHINE_X],
        status: 'pending',
        createdAt: serverTimestamp(),
      }),
    );
  });

  test('member cannot update project distributions directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'project_distributions', 'dist-1'), {
        status: 'cancelled',
      }),
    );
  });

  test('member cannot delete project distributions directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      deleteDoc(doc(db, 'sites', SITE_A, 'project_distributions', 'dist-1')),
    );
  });

  test('site admin cannot write alert settings directly', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'settings', 'alerts'), {
        rules: [{ id: 'cpu-high', metric: 'cpu', threshold: 90 }],
      }),
    );
  });

  test('site admin cannot create webhooks directly', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'webhooks', 'webhook-direct'), {
        name: 'Direct Webhook',
        url: 'https://example.com/direct',
        events: ['machine.offline'],
        enabled: true,
      }),
    );
  });

  test('site admin cannot update webhooks directly', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'webhooks', 'webhook-1'), {
        enabled: false,
      }),
    );
  });

  test('site admin cannot delete webhooks directly', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'sites', SITE_A, 'webhooks', 'webhook-1')));
  });

  test('member cannot delete logs directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'sites', SITE_A, 'logs', 'log-1')));
  });
});

describe('roost version-pointer immutability', () => {
  // The pointer fields on a roost doc (currentVersionId, previousVersionId,
  // versionUrl) are the trust root for "what code runs on the fleet". They
  // can only be flipped by /api/roosts/.../versions and /rollback under
  // the admin SDK (which bypasses these rules and does CAS in a Firestore
  // transaction). A direct browser write would let any site member ship
  // arbitrary code to every targeted machine.
  //
  // Legacy field names (currentManifestId, etc.) are also blocked as
  // defense-in-depth — old roost docs may still carry those keys and we
  // don't want a stale name to become a bypass.

  test('member cannot create a roost with currentVersionId pre-set', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-evil'), {
        name: 'evil',
        targets: [MACHINE_X],
        createdAt: serverTimestamp(),
        schemaVersion: 2,
        currentVersionId: 'attacker-version',
        versionUrl: 'https://attacker.example/payload',
      }),
    );
  });

  test('member cannot flip currentVersionId on an existing roost', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        name: 'kiosk-bundle',
        targets: [MACHINE_X],
        createdAt: Date.now(),
        schemaVersion: 2,
        currentVersionId: 'v-legit',
        versionUrl: 'https://r2.example/legit',
      });
    });

    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        currentVersionId: 'v-evil',
      }),
    );
  });

  test('member cannot flip versionUrl on an existing roost', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        name: 'kiosk-bundle',
        targets: [MACHINE_X],
        createdAt: Date.now(),
        schemaVersion: 2,
        currentVersionId: 'v-legit',
        versionUrl: 'https://r2.example/legit',
      });
    });

    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        versionUrl: 'https://attacker.example/payload',
      }),
    );
  });

  test('member cannot flip previousVersionId on an existing roost', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        name: 'kiosk-bundle',
        targets: [MACHINE_X],
        createdAt: Date.now(),
        schemaVersion: 2,
        currentVersionId: 'v-legit',
        previousVersionId: 'v-prior',
      });
    });

    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-1'), {
        previousVersionId: 'v-evil',
      }),
    );
  });

  test('member cannot flip the legacy currentManifestId field on a roost', async () => {
    // Defense in depth — legacy roost docs predate the manifest->version
    // rename. Even though no code WRITES this field anymore, the rules
    // still block flipping it so a stale doc can't become a bypass.
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-legacy'), {
        name: 'legacy',
        targets: [MACHINE_X],
        createdAt: Date.now(),
        schemaVersion: 2,
        currentManifestId: 'm-legit',
      });
    });

    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-legacy'), {
        currentManifestId: 'm-evil',
      }),
    );
  });

  test('member cannot create a roost with the legacy currentManifestId pre-set', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'roosts', 'roost-legacy-evil'), {
        name: 'legacy-evil',
        targets: [MACHINE_X],
        createdAt: serverTimestamp(),
        schemaVersion: 2,
        currentManifestId: 'attacker-manifest',
      }),
    );
  });
});

describe('machine control-plane writes', () => {
  test('member cannot write pending commands directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'commands', 'pending'),
        {
          'cmd-1': {
            type: 'restart_process',
            status: 'pending',
            createdAt: Date.now(),
          },
        },
        { merge: true },
      ),
    );
  });

  test('member cannot write completed commands directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(
        doc(db, 'sites', SITE_A, 'machines', MACHINE_X, 'commands', 'completed'),
        {
          'cmd-1': {
            type: 'restart_process',
            status: 'completed',
            completedAt: Date.now(),
          },
        },
        { merge: true },
      ),
    );
  });

  test('member cannot toggle configChangeFlag directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X), {
        configChangeFlag: true,
      }),
    );
  });

  test('member cannot toggle cortexEnabled directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X), {
        cortexEnabled: false,
      }),
    );
  });

  test('member cannot delete machines directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'sites', SITE_A, 'machines', MACHINE_X)));
  });

  test('member cannot write machine config directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(
        doc(db, 'config', SITE_A, 'machines', MACHINE_X),
        {
          processes: [
            {
              id: 'proc-1',
              name: 'TouchDesigner',
              path: 'C:\\TouchDesigner\\TouchDesigner.exe',
              launch_mode: 'auto',
            },
          ],
        },
        { merge: true },
      ),
    );
  });

  test('member cannot delete machine config directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'config', SITE_A, 'machines', MACHINE_X)));
  });
});

describe('preset and template control-plane writes', () => {
  test('member cannot create installer templates directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'installer_templates', 'template-direct'), {
        name: 'Direct Installer Template',
        installer_name: 'TouchDesigner.exe',
        createdAt: serverTimestamp(),
      }),
    );
  });

  test('member cannot update installer templates directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'installer_templates', 'template-1'), {
        name: 'Renamed Template',
      }),
    );
  });

  test('member cannot delete installer templates directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      deleteDoc(doc(db, 'sites', SITE_A, 'installer_templates', 'template-1')),
    );
  });

  test('member cannot create project templates directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'project_templates', 'project-template-direct'), {
        name: 'Direct Project Template',
        file_name: 'show.toe',
        createdAt: serverTimestamp(),
      }),
    );
  });

  test('member cannot update project templates directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'project_templates', 'project-template-1'), {
        name: 'Renamed Project Template',
      }),
    );
  });

  test('member cannot delete project templates directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      deleteDoc(doc(db, 'sites', SITE_A, 'project_templates', 'project-template-1')),
    );
  });

  test('member cannot write schedule presets directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'config', SITE_A, 'schedule_presets', 'schedule-direct'), {
        name: 'Direct Schedule',
        cron: '0 18 * * *',
      }),
    );
  });

  test('member cannot write reboot presets directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'config', SITE_A, 'reboot_presets', 'reboot-direct'), {
        name: 'Direct Reboot',
        hour: 4,
        minute: 30,
      }),
    );
  });

  test('member cannot write distribution presets directly', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(
        doc(db, 'config', SITE_A, 'project_distribution_presets', 'distribution-direct'),
        {
          name: 'Direct Distribution Preset',
          targets: [MACHINE_X],
        },
      ),
    );
  });

  test('superadmin cannot create system presets directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(
      setDoc(doc(db, 'system_presets', 'system-preset-direct'), {
        name: 'Direct System Preset',
        software_name: 'TouchDesigner',
        category: 'creative',
        installer_name: 'TouchDesigner.exe',
        silent_flags: '/S',
        order: 2,
        createdAt: serverTimestamp(),
      }),
    );
  });

  test('superadmin cannot update system presets directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(
      updateDoc(doc(db, 'system_presets', 'system-preset-1'), {
        order: 3,
      }),
    );
  });

  test('superadmin cannot delete system presets directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(deleteDoc(doc(db, 'system_presets', 'system-preset-1')));
  });
});

describe('platform control-plane writes', () => {
  test('superadmin cannot change user roles directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(
      updateDoc(doc(db, 'users', TARGET_UID), {
        role: 'admin',
      }),
    );
  });

  test('superadmin cannot assign sites on user docs directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(
      updateDoc(doc(db, 'users', TARGET_UID), {
        sites: [SITE_A],
      }),
    );
  });

  test('superadmin cannot delete users directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(deleteDoc(doc(db, 'users', TARGET_UID)));
  });

  test('superadmin cannot write installer metadata directly', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(
      setDoc(doc(db, 'installer_metadata', 'latest'), {
        version: '2.12.0',
      }),
    );
  });
});
