import crypto from 'crypto';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';

/**
 * Fire-and-forget HTTP client for the audit log cloud function
 * (`recordAuditEvent`). Never awaits, never throws — audit log failures
 * must not degrade request latency or fail the request.
 *
 * Resolution order for the endpoint URL:
 *   1. env `AUDIT_LOG_URL` (full https url to the function)
 *   2. computed from `FIREBASE_PROJECT_ID` + `AUDIT_LOG_REGION`
 *      (default region: us-central1)
 *
 * If neither is available, the call is a no-op (dev environments without
 * cloud functions deployed don't emit — safe default).
 */

const DEFAULT_REGION = 'us-central1';
const AUDIT_TIMEOUT_MS = 3000;

export type ApiKeyAuditContext = {
  keyId: string;
  scopes: ApiKeyScope[] | null;
  environment: 'live' | 'test' | null;
  isLegacy: boolean;
};

function getAuditLogUrl(): string | null {
  const explicit = process.env.AUDIT_LOG_URL;
  if (explicit && explicit.length > 0) return explicit;
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  const region = process.env.AUDIT_LOG_REGION || DEFAULT_REGION;
  return `https://${region}-${projectId}.cloudfunctions.net/recordAuditEvent`;
}

/**
 * Produce a compact, stable fingerprint of a key's scope set. First 12
 * chars of SHA-256 over canonical JSON — tiny (6 bytes of entropy is
 * plenty for audit differentiation), privacy-preserving vs. logging
 * exact resource IDs, and survives scope reordering.
 */
export function scopeFingerprint(scopes: ApiKeyScope[] | null): string {
  if (!scopes || scopes.length === 0) return 'legacy';
  const canonical = [...scopes]
    .map((s) => ({
      resource: s.resource,
      id: s.id,
      permissions: [...s.permissions].sort(),
    }))
    .sort((a, b) => {
      if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 12);
}

export interface ApiKeyUsedEvent {
  siteId: string;
  keyId: string;
  scopeFingerprint: string;
  environment: 'live' | 'test' | 'unknown';
  endpoint: string;
  method: string;
  isLegacy: boolean;
}

/**
 * Fire-and-forget `api_key_used` audit event. Never throws.
 *
 * The returned promise is `void` — callers should NOT await it. Any error
 * is swallowed + logged so audit outages never fail the request path.
 */
export function emitApiKeyUsed(event: ApiKeyUsedEvent): void {
  const url = getAuditLogUrl();
  if (!url) return;

  const body = {
    kind: 'api_key_used' as const,
    siteId: event.siteId,
    actor: `apiKey:${event.keyId}`,
    occurredAt: Date.now(),
    attributes: {
      keyId: event.keyId,
      scopeFingerprint: event.scopeFingerprint,
      environment: event.environment,
      endpoint: event.endpoint,
      method: event.method,
      isLegacy: event.isLegacy,
    },
  };

  postAudit(url, body, 'api_key_used');
}

/**
 * Mutation-event taxonomy used by api-sprint waves 1-3. Each track picks
 * the kind that matches the surface it's promoting; new kinds are added
 * here (and in the cloud function's recogniser) when a new track lands.
 */
export type MutationKind =
  | 'deployment_mutated' // installer-deploys-api: create / retry / cancel / uninstall
  | 'distribution_mutated' // project-distribution-api: create / cancel / delete
  | 'process_mutated' // process-api: create / update / delete / kill / start / stop / schedule
  | 'machine_command_dispatched' // machine-api: reboot / shutdown / capture_screenshot
  | 'user_mutated' // users-api: promote / demote / assign-sites / remove-sites / delete / bootstrap
  | 'site_mutated' // sites-api: create / update / delete (security-boundary-migration wave 3.9)
  | 'site_member_mutated' // /api/sites/{siteId}/members
  | 'installer_mutated' // installer-api: upload / set-latest / delete
  | 'chat_mutated'; // cortex-api: new conversation / rename / soft-delete

export interface MutationEvent {
  /** Mutation kind — see {@link MutationKind}. */
  kind: MutationKind;
  /**
   * Site this mutation belongs to. For platform-wide mutations
   * (`user_mutated`, `installer_mutated`) pass an empty string — the
   * cloud-function side records these under the platform tenant.
   */
  siteId: string;
  /**
   * Who did it. `apiKey:<keyId>` for key-mediated mutations,
   * `user:<uid>` for session/ID-token mediated mutations.
   */
  actor: string;
  /**
   * The resource being mutated — `deploymentId`, `processId`, `uid`,
   * `installerVersion`, `conversationId`, etc. Used as the dedup target
   * for "did this entity change?" queries.
   */
  targetId: string;
  /**
   * Free-form attributes. Convention: include `endpoint` + `method` for
   * traceability, and the verb-specific delta (e.g. `from`/`to` for
   * promote/demote, `reason` for cancel).
   */
  attributes: Record<string, unknown>;
}

/**
 * Fire-and-forget mutation audit. Never throws. Same delivery/abort
 * semantics as {@link emitApiKeyUsed} — callers should not await.
 *
 * One call per mutation. The integration test in
 * `__tests__/api/auditMutationCoverage.test.ts` (added in api-sprint
 * waves 1-3) asserts every mutating route produces exactly one entry.
 */
export function emitMutation(event: MutationEvent): void {
  const url = getAuditLogUrl();
  if (!url) return;

  const body = {
    kind: event.kind,
    siteId: event.siteId,
    actor: event.actor,
    occurredAt: Date.now(),
    target: event.targetId,
    attributes: event.attributes,
  };

  postAudit(url, body, event.kind);
}

/** Internal: shared POST-with-timeout used by every emit helper. */
function postAudit(url: string, body: unknown, label: string): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch((err) => {
      // Audit log failures must NOT propagate. Log at warn so ops can see
      // the outage without spiking error rates.
      console.warn(
        `[auditLogClient] ${label} emit failed: ${(err as Error).message}`,
      );
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}
