export const Capability = {
  MACHINE_EXEC_COMMAND: 'MACHINE_EXEC_COMMAND',
  MACHINE_CONFIG_WRITE: 'MACHINE_CONFIG_WRITE',
  MACHINE_REMOVE: 'MACHINE_REMOVE',
  DEPLOYMENT_MANAGE: 'DEPLOYMENT_MANAGE',
  DISTRIBUTION_MANAGE: 'DISTRIBUTION_MANAGE',
  UNINSTALL_TRIGGER: 'UNINSTALL_TRIGGER',
  PRESET_MANAGE: 'PRESET_MANAGE',
  SITE_MEMBER_MANAGE: 'SITE_MEMBER_MANAGE',
  WEBHOOK_MANAGE: 'WEBHOOK_MANAGE',
  SITE_LOGS_MANAGE: 'SITE_LOGS_MANAGE',
  USER_ROLE_MANAGE: 'USER_ROLE_MANAGE',
  USER_DELETE: 'USER_DELETE',
  SYSTEM_PRESET_MANAGE: 'SYSTEM_PRESET_MANAGE',
  INSTALLER_MANAGE: 'INSTALLER_MANAGE',
  GLOBAL_SETTINGS_WRITE: 'GLOBAL_SETTINGS_WRITE',
  USER_SELF_PREFS: 'USER_SELF_PREFS',
  USER_SELF_DELETE: 'USER_SELF_DELETE',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export type Role = 'member' | 'admin' | 'superadmin';

export type SystemActorName =
  | 'cortex_autonomous'
  | 'cortex_provisioning'
  | 'scheduled_cleanup';

export type UserActor = {
  type: 'user';
  userId: string;
  /** Present when the user is acting through an API key. */
  apiKeyId?: string;
  role: Role;
  sites: string[];
};

export type SystemActor = {
  type: 'system';
  name: SystemActorName;
  siteId: string;
};

export type Actor = UserActor | SystemActor;

const MEMBER_CAPABILITIES: readonly Capability[] = [
  Capability.USER_SELF_PREFS,
  Capability.USER_SELF_DELETE,
];

const SITE_ADMIN_CAPABILITIES: readonly Capability[] = [
  ...MEMBER_CAPABILITIES,
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_CONFIG_WRITE,
  // Site-scoped (see SITE_SCOPED_CAPABILITIES): admins can remove machines on their
  // OWN assigned sites; superadmins on any site.
  Capability.MACHINE_REMOVE,
  Capability.DEPLOYMENT_MANAGE,
  Capability.DISTRIBUTION_MANAGE,
  Capability.UNINSTALL_TRIGGER,
  Capability.PRESET_MANAGE,
  Capability.WEBHOOK_MANAGE,
  Capability.SITE_LOGS_MANAGE,
  Capability.SITE_MEMBER_MANAGE,
];

const SUPERADMIN_CAPABILITIES: readonly Capability[] = Object.values(Capability);

const SITE_SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_CONFIG_WRITE,
  Capability.MACHINE_REMOVE,
  Capability.DEPLOYMENT_MANAGE,
  Capability.DISTRIBUTION_MANAGE,
  Capability.UNINSTALL_TRIGGER,
  Capability.PRESET_MANAGE,
  Capability.SITE_MEMBER_MANAGE,
  Capability.WEBHOOK_MANAGE,
  Capability.SITE_LOGS_MANAGE,
]);

export const RoleCapabilityMatrix: Readonly<Record<Role, readonly Capability[]>> = {
  member: MEMBER_CAPABILITIES,
  admin: SITE_ADMIN_CAPABILITIES,
  superadmin: SUPERADMIN_CAPABILITIES,
};

export const SystemCapabilityMatrix: Readonly<
  Record<SystemActorName, readonly Capability[]>
> = {
  cortex_autonomous: [
    Capability.MACHINE_EXEC_COMMAND,
    Capability.MACHINE_CONFIG_WRITE,
  ],
  cortex_provisioning: [],
  scheduled_cleanup: [
    Capability.MACHINE_REMOVE,
    Capability.DEPLOYMENT_MANAGE,
  ],
};

export function isSiteScopedCapability(capability: Capability): boolean {
  return SITE_SCOPED_CAPABILITIES.has(capability);
}

export function hasCapability(
  actor: Actor,
  capability: Capability,
  siteId?: string
): boolean {
  if (actor.type === 'system') {
    const allowed = SystemCapabilityMatrix[actor.name];
    if (!allowed.includes(capability)) return false;
    if (isSiteScopedCapability(capability)) {
      if (!siteId) return false;
      if (actor.siteId !== siteId) return false;
    }
    return true;
  }

  const granted = RoleCapabilityMatrix[actor.role];
  if (!granted.includes(capability)) return false;

  if (isSiteScopedCapability(capability)) {
    if (actor.role === 'superadmin') return true;
    if (!siteId) return false;
    return actor.sites.includes(siteId);
  }

  return true;
}
