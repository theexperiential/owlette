/**
 * @jest-environment node
 */
import {
  Capability,
  RoleCapabilityMatrix,
  SystemCapabilityMatrix,
  hasCapability,
  isSiteScopedCapability,
  type Actor,
  type Role,
  type SystemActorName,
  type UserActor,
  type SystemActor,
} from '@/lib/capabilities';

const ALL_CAPABILITIES: Capability[] = Object.values(Capability);

const SITE_SCOPED: Capability[] = [
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_CONFIG_WRITE,
  Capability.MACHINE_REMOVE,
  Capability.DEPLOYMENT_MANAGE,
  Capability.DISTRIBUTION_MANAGE,
  Capability.UNINSTALL_TRIGGER,
  Capability.PRESET_MANAGE,
  Capability.SITE_MEMBER_MANAGE,
  Capability.WEBHOOK_MANAGE,
];

const GLOBAL_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (c) => !SITE_SCOPED.includes(c)
);

function userActor(overrides: Partial<UserActor> = {}): UserActor {
  return {
    type: 'user',
    userId: 'uid_default',
    role: 'member',
    sites: [],
    ...overrides,
  };
}

function systemActor(overrides: Partial<SystemActor> = {}): SystemActor {
  return {
    type: 'system',
    name: 'cortex_autonomous',
    siteId: 'site_default',
    ...overrides,
  };
}

describe('Capability enum', () => {
  it('exposes the full vocabulary expected by the security-boundary plan', () => {
    expect(new Set(ALL_CAPABILITIES)).toEqual(
      new Set([
        'MACHINE_EXEC_COMMAND',
        'MACHINE_CONFIG_WRITE',
        'MACHINE_REMOVE',
        'DEPLOYMENT_MANAGE',
        'DISTRIBUTION_MANAGE',
        'UNINSTALL_TRIGGER',
        'PRESET_MANAGE',
        'SITE_MEMBER_MANAGE',
        'WEBHOOK_MANAGE',
        'USER_ROLE_MANAGE',
        'USER_DELETE',
        'SYSTEM_PRESET_MANAGE',
        'INSTALLER_MANAGE',
        'GLOBAL_SETTINGS_WRITE',
        'USER_SELF_PREFS',
        'USER_SELF_DELETE',
      ])
    );
  });
});

describe('RoleCapabilityMatrix', () => {
  it('member gets only self-prefs + self-delete', () => {
    expect([...RoleCapabilityMatrix.member].sort()).toEqual(
      ['USER_SELF_DELETE', 'USER_SELF_PREFS'].sort()
    );
  });

  it('admin gets member caps plus the eight site-scoped admin caps', () => {
    expect([...RoleCapabilityMatrix.admin].sort()).toEqual(
      [
        'USER_SELF_PREFS',
        'USER_SELF_DELETE',
        'MACHINE_EXEC_COMMAND',
        'MACHINE_CONFIG_WRITE',
        'DEPLOYMENT_MANAGE',
        'DISTRIBUTION_MANAGE',
        'UNINSTALL_TRIGGER',
        'PRESET_MANAGE',
        'WEBHOOK_MANAGE',
        'SITE_MEMBER_MANAGE',
      ].sort()
    );
  });

  it('superadmin gets every capability', () => {
    expect([...RoleCapabilityMatrix.superadmin].sort()).toEqual(
      [...ALL_CAPABILITIES].sort()
    );
  });

  it('admin does NOT include MACHINE_REMOVE (superadmin-only delete)', () => {
    expect(RoleCapabilityMatrix.admin).not.toContain(Capability.MACHINE_REMOVE);
  });

  it('admin does NOT include any global capability', () => {
    for (const cap of GLOBAL_CAPABILITIES) {
      if (cap === Capability.USER_SELF_PREFS || cap === Capability.USER_SELF_DELETE) continue;
      expect(RoleCapabilityMatrix.admin).not.toContain(cap);
    }
  });
});

describe('SystemCapabilityMatrix', () => {
  it('cortex_autonomous allowlist is exactly [MACHINE_EXEC_COMMAND, MACHINE_CONFIG_WRITE]', () => {
    expect([...SystemCapabilityMatrix.cortex_autonomous].sort()).toEqual(
      ['MACHINE_CONFIG_WRITE', 'MACHINE_EXEC_COMMAND'].sort()
    );
  });

  it('cortex_provisioning has no capabilities by default', () => {
    expect(SystemCapabilityMatrix.cortex_provisioning).toEqual([]);
  });

  it('scheduled_cleanup carries cleanup-oriented capabilities only', () => {
    expect([...SystemCapabilityMatrix.scheduled_cleanup].sort()).toEqual(
      ['DEPLOYMENT_MANAGE', 'MACHINE_REMOVE'].sort()
    );
  });
});

describe('isSiteScopedCapability', () => {
  it.each(SITE_SCOPED)('%s is site-scoped', (cap) => {
    expect(isSiteScopedCapability(cap)).toBe(true);
  });

  it.each(GLOBAL_CAPABILITIES)('%s is global (not site-scoped)', (cap) => {
    expect(isSiteScopedCapability(cap)).toBe(false);
  });
});

describe('hasCapability — user actor (every role × every capability)', () => {
  const roles: Role[] = ['member', 'admin', 'superadmin'];

  for (const role of roles) {
    for (const cap of ALL_CAPABILITIES) {
      const grants = RoleCapabilityMatrix[role].includes(cap);
      const isScoped = SITE_SCOPED.includes(cap);

      it(`${role} × ${cap} — granted=${grants}, scoped=${isScoped}`, () => {
        const actor = userActor({
          role,
          sites: ['site_a'],
        });

        if (!grants) {
          expect(hasCapability(actor, cap, 'site_a')).toBe(false);
          expect(hasCapability(actor, cap)).toBe(false);
          return;
        }

        if (isScoped) {
          if (role === 'superadmin') {
            expect(hasCapability(actor, cap, 'site_anywhere')).toBe(true);
            expect(hasCapability(actor, cap)).toBe(true);
          } else {
            expect(hasCapability(actor, cap, 'site_a')).toBe(true);
            expect(hasCapability(actor, cap, 'site_other')).toBe(false);
            expect(hasCapability(actor, cap)).toBe(false);
          }
        } else {
          expect(hasCapability(actor, cap)).toBe(true);
          expect(hasCapability(actor, cap, 'site_a')).toBe(true);
        }
      });
    }
  }
});

describe('hasCapability — site-scope enforcement edge cases', () => {
  it('admin with empty sites array is denied every site-scoped capability', () => {
    const actor = userActor({ role: 'admin', sites: [] });
    for (const cap of SITE_SCOPED) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('admin without siteId argument is denied site-scoped capabilities', () => {
    const actor = userActor({ role: 'admin', sites: ['site_a'] });
    for (const cap of SITE_SCOPED) {
      if (!RoleCapabilityMatrix.admin.includes(cap)) continue;
      expect(hasCapability(actor, cap)).toBe(false);
    }
  });

  it('admin granted only on assigned site', () => {
    const actor = userActor({ role: 'admin', sites: ['site_a', 'site_b'] });
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_a')).toBe(true);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_b')).toBe(true);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_c')).toBe(false);
  });

  it('superadmin bypasses site-scope check entirely (no siteId required)', () => {
    const actor = userActor({ role: 'superadmin', sites: [] });
    for (const cap of SITE_SCOPED) {
      expect(hasCapability(actor, cap)).toBe(true);
      expect(hasCapability(actor, cap, 'site_anything')).toBe(true);
    }
  });

  it('member is denied site-scoped capabilities even on their assigned site', () => {
    const actor = userActor({ role: 'member', sites: ['site_a'] });
    for (const cap of SITE_SCOPED) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('member retains self-prefs and self-delete (global, no siteId required)', () => {
    const actor = userActor({ role: 'member', sites: [] });
    expect(hasCapability(actor, Capability.USER_SELF_PREFS)).toBe(true);
    expect(hasCapability(actor, Capability.USER_SELF_DELETE)).toBe(true);
  });
});

describe('hasCapability — system actor allowlist', () => {
  const allActors: SystemActorName[] = [
    'cortex_autonomous',
    'cortex_provisioning',
    'scheduled_cleanup',
  ];

  for (const name of allActors) {
    for (const cap of ALL_CAPABILITIES) {
      const allowed = SystemCapabilityMatrix[name].includes(cap);
      const isScoped = SITE_SCOPED.includes(cap);

      it(`${name} × ${cap} — allowed=${allowed}, scoped=${isScoped}`, () => {
        const actor = systemActor({ name, siteId: 'site_a' });

        if (!allowed) {
          expect(hasCapability(actor, cap, 'site_a')).toBe(false);
          expect(hasCapability(actor, cap)).toBe(false);
          return;
        }

        if (isScoped) {
          expect(hasCapability(actor, cap, 'site_a')).toBe(true);
          expect(hasCapability(actor, cap, 'site_other')).toBe(false);
          expect(hasCapability(actor, cap)).toBe(false);
        } else {
          expect(hasCapability(actor, cap)).toBe(true);
          expect(hasCapability(actor, cap, 'site_a')).toBe(true);
        }
      });
    }
  }

  it('cortex_provisioning is denied every capability (empty allowlist)', () => {
    const actor = systemActor({ name: 'cortex_provisioning', siteId: 'site_a' });
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('cortex_autonomous denied non-allowlisted site-scoped capabilities', () => {
    const actor = systemActor({ name: 'cortex_autonomous', siteId: 'site_a' });
    expect(hasCapability(actor, Capability.MACHINE_REMOVE, 'site_a')).toBe(false);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_a')).toBe(false);
    expect(hasCapability(actor, Capability.WEBHOOK_MANAGE, 'site_a')).toBe(false);
  });

  it('cortex_autonomous denied non-allowlisted global capabilities', () => {
    const actor = systemActor({ name: 'cortex_autonomous', siteId: 'site_a' });
    expect(hasCapability(actor, Capability.INSTALLER_MANAGE)).toBe(false);
    expect(hasCapability(actor, Capability.USER_ROLE_MANAGE)).toBe(false);
    expect(hasCapability(actor, Capability.GLOBAL_SETTINGS_WRITE)).toBe(false);
  });

  it('scheduled_cleanup can perform cleanup capabilities only on its assigned siteId', () => {
    const actor = systemActor({ name: 'scheduled_cleanup', siteId: 'site_cleanup' });
    expect(hasCapability(actor, Capability.MACHINE_REMOVE, 'site_cleanup')).toBe(true);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_cleanup')).toBe(true);
    expect(hasCapability(actor, Capability.MACHINE_REMOVE, 'site_other')).toBe(false);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_other')).toBe(false);
  });

  it('system actor without siteId argument denied site-scoped capabilities', () => {
    const actor = systemActor({ name: 'cortex_autonomous', siteId: 'site_a' });
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND)).toBe(false);
    expect(hasCapability(actor, Capability.MACHINE_CONFIG_WRITE)).toBe(false);
  });
});

describe('hasCapability — discriminated union routing', () => {
  it('routes user actor through RoleCapabilityMatrix', () => {
    const actor: Actor = {
      type: 'user',
      userId: 'uid_x',
      role: 'admin',
      sites: ['site_a'],
    };
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_a')).toBe(true);
  });

  it('routes system actor through SystemCapabilityMatrix', () => {
    const actor: Actor = {
      type: 'system',
      name: 'cortex_autonomous',
      siteId: 'site_a',
    };
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a')).toBe(true);
  });
});
