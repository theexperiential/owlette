export type ApiKeyPermission = 'read' | 'write' | 'deploy' | 'rollback' | 'admin';
export type ApiKeyResource = 'roost' | 'site' | 'machine';
export type ApiKeyEnvironment = 'live' | 'test';

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

/** Wildcard scopes for all three resource types. */
function wildcardScopes(permissions: ApiKeyPermission[]): ApiKeyScope[] {
  return (['roost', 'site', 'machine'] as ApiKeyResource[]).map((resource) => ({
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
