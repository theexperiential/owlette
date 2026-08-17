export type ApiKeyPermission = 'read' | 'write' | 'deploy' | 'rollback' | 'admin';
export type ApiKeyResource =
  | 'roost'
  | 'site'
  | 'machine'
  // api-sprint additions:
  | 'chat' // site-scoped hoot conversations
  | 'deploy' // site-scoped classic-installer deploys (distinct from the `deploy` permission on roosts)
  | 'process' // machine-scoped process management
  | 'user' // platform-wide user administration (superadmin)
  | 'installer'; // platform-wide installer-binary management (superadmin)
export type ApiKeyEnvironment = 'live' | 'test';

/**
 * Canonical list of every accepted resource type. Imported by route
 * validators + the dashboard scope picker so the allowlist can't drift
 * across multiple call sites.
 */
export const ALL_RESOURCES: readonly ApiKeyResource[] = [
  'roost',
  'site',
  'machine',
  'chat',
  'deploy',
  'process',
  'user',
  'installer',
];

/**
 * Resources that require superadmin to grant. Route validators reject
 * scope creation if a non-superadmin attempts to mint a key carrying
 * any of these.
 */
export const SUPERADMIN_ONLY_RESOURCES: readonly ApiKeyResource[] = ['user', 'installer'];

export interface ApiKeyScope {
  resource: ApiKeyResource;
  /** Specific resource ID or '*' for all resources of this type */
  id: string;
  permissions: ApiKeyPermission[];
}

/**
 * Stored in users/{userId}/api_keys/{keyId}.
 * The raw key is never stored — only the SHA-256 hash.
 */
export interface ApiKeyRecord {
  name: string;
  keyHash: string;
  /** First 15 chars of raw key for display (e.g. "owk_live_XXXXXXX") */
  keyPrefix: string;
  environment: ApiKeyEnvironment;
  scopes: ApiKeyScope[];
  /** Unix milliseconds. Keys MUST have an expiration (default 90d, max 365d). */
  expiresAt: number;
  createdAt: FirebaseFirestore.Timestamp | number;
  lastUsedAt: FirebaseFirestore.Timestamp | number | null;
  /** Set when this key was rotated. The old key's retiresAt = rotatedAt + 24h. */
  rotatedAt?: number;
  rotatedFromKeyId?: string;
  /** When the old key stops working after rotation (rotatedAt + 24 hours). */
  retiresAt?: number;
  /** Set on revocation. */
  revokedAt?: number;
}

/**
 * Stored in api_keys/{keyHash} (top-level lookup table).
 * Denormalized for O(1) auth resolution — one doc read, no join.
 */
export interface ApiKeyLookup {
  userId: string;
  keyId: string;
  environment: ApiKeyEnvironment;
  /** Denormalized copy of scopes for fast enforcement without a second read. */
  scopes: ApiKeyScope[];
  expiresAt: number;
  /** Set during rotation grace period. Old key valid until retiresAt. */
  retiresAt?: number;
}

export type ApiKeyScopePreset = 'readonly' | 'publisher' | 'operator' | 'admin';

/** Wildcard scopes for common operator resources. */
function wildcardScopes(permissions: ApiKeyPermission[]): ApiKeyScope[] {
  return (['roost', 'site', 'machine', 'chat'] as ApiKeyResource[]).map((resource) => ({
    resource,
    id: '*',
    permissions,
  }));
}

export const SCOPE_PRESETS: Record<ApiKeyScopePreset, ApiKeyScope[]> = {
  readonly: wildcardScopes(['read']),
  publisher: wildcardScopes(['read', 'write']),
  operator: wildcardScopes(['read', 'write', 'deploy', 'rollback']),
  admin: wildcardScopes(['read', 'write', 'deploy', 'rollback', 'admin']),
};

/** Ordered preset keys for scope pickers (excludes the synthetic "custom" option). */
export const SCOPE_PRESET_KEYS: readonly ApiKeyScopePreset[] = [
  'readonly',
  'publisher',
  'operator',
  'admin',
];

/**
 * Display labels for the presets.
 *
 * The keys are code identifiers — they index SCOPE_PRESETS, back the
 * `ApiKeyScopePreset` union, and are the `<SelectItem value>` in every picker.
 * Rendering them raw leaked `readonly` into the UI as a scope's name. The
 * identifier stays; only what a human reads changes. Nothing persists or
 * transmits the preset name (a preset expands to `scopes` before the POST),
 * so this is purely presentational.
 */
export const SCOPE_PRESET_LABELS: Record<ApiKeyScopePreset, string> = {
  readonly: 'read only',
  publisher: 'publisher',
  operator: 'operator',
  admin: 'admin',
};

/** Human-readable descriptions of each preset, shared across every scope picker. */
export const SCOPE_PRESET_DESCRIPTIONS: Record<ApiKeyScopePreset, string> = {
  readonly: 'read access to roosts, sites, machines, and hoot chats — no mutations',
  publisher: 'read + write — can upload chunks, publish versions, and use hoot chats',
  operator: 'read, write, deploy, rollback — full day-to-day operations',
  admin: 'full access including admin permissions',
};

export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Returns true if a resolved key has at least one scope entry matching
 * (resource, id, permission). Wildcard id ('*') in the stored scope matches
 * any requested id.
 */
export function scopeMatches(
  scopes: ApiKeyScope[],
  resource: ApiKeyResource,
  id: string,
  permission: ApiKeyPermission
): boolean {
  return scopes.some(
    (s) =>
      s.resource === resource &&
      (s.id === '*' || s.id === id) &&
      s.permissions.includes(permission)
  );
}

/**
 * The shape `GET /api/keys` returns, and the only shape the key UIs read.
 *
 * Declared here rather than beside a component on purpose. It used to live in
 * KeyCard.tsx, where it described fields the route never actually sent —
 * `expired`, `retired` and `expiredMarkedAt` were always `undefined`, so the
 * "expired" badge could not render, and an expired key sat under a heading
 * that called it active. Sharing the type makes that a compile error instead.
 *
 * Every instant here is epoch milliseconds. The stored record is not
 * consistent — `createdAt` is a Firestore Timestamp (written with
 * serverTimestamp()) while `lastUsedAt` is a plain number (written with
 * Date.now()) — so the route normalises through {@link toEpochMillis} before
 * serialising. Returning the raw Timestamp made `new Date(...)` yield
 * "Invalid Date" in the dashboard for every key created after the switch to
 * serverTimestamp().
 */
export interface ApiKeyListItem {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  environment: ApiKeyEnvironment | null;
  scopes: ApiKeyScope[] | null;
  expiresAt: number | null;
  createdAt: number | null;
  lastUsedAt: number | null;
  rotatedAt: number | null;
  rotatedFromKeyId: string | null;
  retiresAt: number | null;
  revokedAt: number | null;
  expiredMarkedAt: number | null;
  /** Derived: past its expiry at the moment the list was built. */
  expired: boolean;
  /** Derived: a rotated key whose grace window has closed. */
  retired: boolean;
}

/**
 * Coerce any instant this codebase has ever stored into epoch milliseconds.
 *
 * Handles the three shapes that reach it: a plain number, a live
 * Firestore Timestamp (Admin SDK, has `toMillis()`), and a Timestamp that has
 * already been through JSON (`{_seconds, _nanoseconds}` or `{seconds, ...}`).
 * Anything else — including a FieldValue sentinel read back before the write
 * lands — returns null rather than a nonsense date.
 */
export function toEpochMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object') {
    const t = value as {
      toMillis?: unknown;
      _seconds?: unknown;
      seconds?: unknown;
      _nanoseconds?: unknown;
      nanoseconds?: unknown;
    };
    if (typeof t.toMillis === 'function') {
      const ms = (t.toMillis as () => unknown)();
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
    const secs = typeof t._seconds === 'number' ? t._seconds
      : typeof t.seconds === 'number' ? t.seconds : null;
    if (secs !== null) {
      const nanos = typeof t._nanoseconds === 'number' ? t._nanoseconds
        : typeof t.nanoseconds === 'number' ? t.nanoseconds : 0;
      return secs * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
}

/**
 * Build the list item the UIs consume from a stored record.
 *
 * `now` is injected so a single listing classifies every key against one
 * instant, and so the derivation is testable without faking the clock.
 */
export function buildApiKeyListItem(
  id: string,
  data: Record<string, unknown>,
  now: number
): ApiKeyListItem {
  const expiresAt = toEpochMillis(data.expiresAt);
  const retiresAt = toEpochMillis(data.retiresAt);
  const rotatedAt = toEpochMillis(data.rotatedAt);
  return {
    id,
    name: typeof data.name === 'string' ? data.name : null,
    keyPrefix: typeof data.keyPrefix === 'string' ? data.keyPrefix : null,
    environment:
      data.environment === 'live' || data.environment === 'test' ? data.environment : null,
    scopes: Array.isArray(data.scopes) ? (data.scopes as ApiKeyScope[]) : null,
    expiresAt,
    createdAt: toEpochMillis(data.createdAt),
    lastUsedAt: toEpochMillis(data.lastUsedAt),
    rotatedAt,
    rotatedFromKeyId:
      typeof data.rotatedFromKeyId === 'string' ? data.rotatedFromKeyId : null,
    retiresAt,
    revokedAt: toEpochMillis(data.revokedAt),
    expiredMarkedAt: toEpochMillis(data.expiredMarkedAt),
    expired: expiresAt !== null && expiresAt <= now,
    // A rotated key stops working once its grace window closes. Without
    // rotatedAt there is no grace window and the key is simply live.
    retired: rotatedAt !== null && retiresAt !== null && retiresAt <= now,
  };
}
