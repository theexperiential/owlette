/**
 * system invoker (security-boundary-migration wave 2.3).
 *
 * Single entry point for any code path that needs to act as a system
 * actor — cortex autonomous mode, cortex provisioning, scheduled jobs.
 * Mirrors the authorization pipeline that `authorizedHandler` enforces
 * for http requests so the same audit + rate-limit + kill-switch
 * semantics apply to background work.
 *
 * Flow per call:
 *   1. Validate `actor.type === 'system'` and `actor.name` is one of the
 *      known `SystemActorName` values. Throws synchronously on a bad
 *      actor (this is a programmer error — no audit row to write).
 *   2. Capture a stack-trace fingerprint of the caller module and stamp
 *      it into `metadata.callerModule`. If the fingerprint does NOT
 *      match an expected pattern (`web/lib/cortex/`, `web/lib/jobs/`,
 *      or a test file), emit a `logger.error('UNEXPECTED_SYSTEM_INVOKER_CALLER')`
 *      so wave 8.2 monitoring can fire on this. Never throws — this is a
 *      defense-in-depth alert layered on top of the eslint + ci-scan
 *      import-graph allowlist.
 *   3. Look up `SystemCapabilityMatrix[actor.name]`. If `capability` is
 *      not in the allowlist, write a `deny` audit entry (fire-and-forget)
 *      and throw `SystemInvokerCapabilityDenied`. Respects the
 *      `capability_enforcement` kill switch — when off, the deny still
 *      gets audited with `enforcementBypassed: true` and the action
 *      proceeds.
 *   4. Run `checkRateLimit(actor, capability, siteId)` against the
 *      `'system'` bucket (selected by `bucketForActor`). On a rate-limit
 *      reject, write a `deny` audit and throw `SystemInvokerRateLimited`.
 *      Respects the `rate_limit_enforcement` kill switch.
 *   5. Generate a `correlationId` and write an `allow` audit entry using
 *      `writeAuditEntryBlocking`. If the audit write fails, throw
 *      `SystemInvokerAuditUnavailable` BEFORE invoking the action — a
 *      privileged action without an audit record is the worst-case
 *      outcome and we'd rather fail closed.
 *   6. Invoke `action({ actor, siteId, correlationId })`.
 *   7. On thrown error inside `action`, write an `error` audit entry
 *      (fire-and-forget) and re-throw. The original error surface is
 *      preserved.
 *
 * Import-graph allowlist (defense in depth):
 *   - eslint rule `no-restricted-imports` blocks importing this module
 *     from outside `web/lib/cortex/**`, `web/lib/jobs/**`, and tests.
 *   - `scripts/check-system-invoker-callers.mjs` re-checks the same
 *     allowlist at ci time using a typescript ast walk, so a stale or
 *     bypassed eslint config doesn't silently let a misuse through.
 *   - The runtime `metadata.callerModule` alert above is the third
 *     layer — even if both static checks were defeated, an unexpected
 *     caller path lights up logs at error level.
 */

import {
  type SystemActor,
  type SystemActorName,
  type Capability,
  SystemCapabilityMatrix,
} from '@/lib/capabilities';
import {
  generateCorrelationId,
  writeAuditEntry,
  writeAuditEntryBlocking,
  type AuditEntryInput,
  type AuditTarget,
} from '@/lib/auditLog.server';
import { checkRateLimit, bucketForActor } from '@/lib/rateLimit.server';
import { securityConfig } from '@/lib/securityConfig.server';
import logger from '@/lib/logger';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';

/* -------------------------------------------------------------------------- */
/*  types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SystemInvokerContext {
  actor: SystemActor;
  siteId: string;
  correlationId: string;
}

export interface SystemInvokerOptions<T> {
  actor: SystemActor;
  capability: Capability;
  siteId: string;
  /** Optional explicit target (defaults to a `site`-kinded target on `siteId`). */
  target?: AuditTarget;
  metadata?: Record<string, unknown>;
  action: (ctx: SystemInvokerContext) => Promise<T>;
}

/* -------------------------------------------------------------------------- */
/*  errors                                                                    */
/* -------------------------------------------------------------------------- */

export class SystemInvokerError extends Error {
  readonly code: string;
  readonly correlationId?: string;
  constructor(code: string, message: string, correlationId?: string) {
    super(message);
    this.name = 'SystemInvokerError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

export class SystemInvokerCapabilityDenied extends SystemInvokerError {
  constructor(actorName: SystemActorName, capability: Capability, correlationId?: string) {
    super(
      'capability_denied',
      `system actor '${actorName}' is not allowed capability '${capability}'`,
      correlationId,
    );
    this.name = 'SystemInvokerCapabilityDenied';
  }
}

export class SystemInvokerRateLimited extends SystemInvokerError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, correlationId?: string) {
    super('rate_limited', `system actor rate-limited (retry after ${retryAfterSec}s)`, correlationId);
    this.name = 'SystemInvokerRateLimited';
    this.retryAfterSec = retryAfterSec;
  }
}

export class SystemInvokerAuditUnavailable extends SystemInvokerError {
  readonly cause: unknown;
  constructor(cause: unknown, correlationId?: string) {
    super(
      'audit_unavailable',
      'audit log unavailable; refusing to invoke privileged action',
      correlationId,
    );
    this.name = 'SystemInvokerAuditUnavailable';
    this.cause = cause;
  }
}

export class SystemInvokerInvalidActor extends SystemInvokerError {
  constructor(reason: string) {
    super('invalid_actor', `invalid system actor: ${reason}`);
    this.name = 'SystemInvokerInvalidActor';
  }
}

/* -------------------------------------------------------------------------- */
/*  caller fingerprint                                                        */
/* -------------------------------------------------------------------------- */

const KNOWN_SYSTEM_ACTOR_NAMES: ReadonlySet<string> = new Set<SystemActorName>([
  'cortex_autonomous',
  'cortex_provisioning',
  'scheduled_cleanup',
]);

/**
 * Patterns the caller fingerprint MUST match. Anything else is logged at
 * error level via `UNEXPECTED_SYSTEM_INVOKER_CALLER` so wave 8.2 metric
 * picks it up. Match against the path-normalized fingerprint (forward
 * slashes); test-files include both `__tests__` directories and
 * `*.test.ts` filenames so unit tests running through this code path
 * don't trip the alert.
 */
const ALLOWED_CALLER_PATTERNS: readonly RegExp[] = [
  /(^|\/)web\/lib\/cortex\//,
  /(^|\/)web\/lib\/jobs\//,
  /(^|\/)web\/__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

/**
 * Extract a stable, repo-relative fingerprint of the immediate caller of
 * `invokeAsSystem`. Returns `unknown` when the runtime stack trace can't
 * be parsed (e.g. minified production builds with no original sources).
 *
 * Strategy: walk `new Error().stack`, skip frames that point at this
 * file itself, and return the first one that doesn't. Strip absolute
 * path prefixes so the fingerprint is stable across machines.
 */
export function captureCallerFingerprint(stackOverride?: string): string {
  const stack = stackOverride ?? new Error().stack ?? '';
  const lines = stack.split('\n');
  // Skip the leading "Error" line + any frame whose source location
  // points back at this module.
  for (const rawLine of lines) {
    const frame = parseStackFrame(rawLine);
    if (!frame) continue;
    if (frame.includes('systemInvoker.server')) continue;
    return frame;
  }
  return 'unknown';
}

/**
 * Parse one v8-style stack frame line and return the source location
 * (path + line + column) normalized to forward slashes and trimmed of
 * the absolute repo prefix.
 *
 * Handles both:
 *   "    at Foo (C:/repo/web/lib/x.ts:12:34)"
 *   "    at C:/repo/web/lib/x.ts:12:34"
 */
function parseStackFrame(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ')) return null;
  // Match "(...)" form first.
  const parenMatch = trimmed.match(/\(([^)]+)\)\s*$/);
  const loc = parenMatch ? parenMatch[1] : trimmed.slice(3); // strip "at "
  if (!loc || loc === 'native' || loc.startsWith('<anonymous>')) return null;

  // Drop file:// prefix if present (esm).
  let normalized = loc.replace(/^file:\/\/\/?/, '');
  // Forward slashes for cross-platform stability.
  normalized = normalized.replace(/\\/g, '/');
  // Strip drive letters on windows ("C:/..." -> "/...").
  normalized = normalized.replace(/^[A-Za-z]:\//, '/');

  // Strip the repo-root prefix so fingerprints are stable across machines.
  // We can't know the repo root statically, but `web/`, `agent/`, and
  // `scripts/` are stable suffixes — find one and trim everything before.
  const repoIdx = findRepoRelativeStart(normalized);
  if (repoIdx >= 0) normalized = normalized.slice(repoIdx);

  return normalized;
}

function findRepoRelativeStart(p: string): number {
  // Look for a known top-level repo dir; pick the rightmost occurrence so
  // a path like `/foo/web/.../web/lib/...` resolves to the deepest match.
  const markers = ['/web/', '/agent/', '/scripts/', '/cli/'];
  let best = -1;
  for (const m of markers) {
    const idx = p.lastIndexOf(m);
    if (idx > best) best = idx + 1; // +1 to drop the leading slash
  }
  return best;
}

function isAllowedCaller(fingerprint: string): boolean {
  if (fingerprint === 'unknown') return false;
  // Strip line:column suffix before pattern matching (so /web/lib/cortex/foo.ts:12:3 still matches).
  const sourcePath = fingerprint.replace(/:\d+:\d+$/, '');
  return ALLOWED_CALLER_PATTERNS.some((re) => re.test(sourcePath));
}

/* -------------------------------------------------------------------------- */
/*  validators                                                                */
/* -------------------------------------------------------------------------- */

function validateActor(actor: unknown): asserts actor is SystemActor {
  if (!actor || typeof actor !== 'object') {
    throw new SystemInvokerInvalidActor('actor must be an object');
  }
  const candidate = actor as Partial<SystemActor>;
  if (candidate.type !== 'system') {
    throw new SystemInvokerInvalidActor(
      `expected actor.type === 'system', got ${String(candidate.type)}`,
    );
  }
  if (!candidate.name || !KNOWN_SYSTEM_ACTOR_NAMES.has(candidate.name)) {
    throw new SystemInvokerInvalidActor(
      `unknown system actor name: ${String(candidate.name)}`,
    );
  }
  if (!candidate.siteId || typeof candidate.siteId !== 'string') {
    throw new SystemInvokerInvalidActor('actor.siteId must be a non-empty string');
  }
}

/* -------------------------------------------------------------------------- */
/*  entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Run `action` as a system actor with full audit + capability + rate-limit
 * mediation. See module docstring for the full pipeline; throws one of
 * `SystemInvoker*` errors on any failure that prevents the action from
 * running. Once `action` is invoked, errors from inside it are re-thrown
 * unchanged after best-effort error-audit write.
 */
export async function invokeAsSystem<T>(
  options: SystemInvokerOptions<T>,
): Promise<T> {
  const { actor, capability, siteId, target, metadata, action } = options;

  validateActor(actor);
  if (!siteId || typeof siteId !== 'string') {
    throw new SystemInvokerInvalidActor('siteId must be a non-empty string');
  }

  const callerModule = captureCallerFingerprint();
  if (!isAllowedCaller(callerModule)) {
    // Defense-in-depth runtime alert. Static checks (eslint + ci scan)
    // are the primary gate; this fires when both have been bypassed or
    // when an unexpected dynamic require() somehow lands here.
    logger.error('UNEXPECTED_SYSTEM_INVOKER_CALLER', {
      context: 'systemInvoker',
      data: {
        callerModule,
        actorName: actor.name,
        capability,
        siteId,
      },
    });
    emitSecurityBoundaryMetric('system_invoker_unexpected_caller_total', 1, {
      severity: 'error',
      labels: {
        actorName: actor.name,
        capability,
        site: siteId,
      },
      fields: {
        callerModule,
      },
    });
  }

  const auditTarget: AuditTarget =
    target ?? { kind: 'site', id: siteId };
  const correlationId = generateCorrelationId();

  const auditMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    callerModule,
  };

  // Read kill-switch state once per call so capability + rate-limit
  // checks see the same view.
  const config = await securityConfig.read();

  /* -- capability check ---------------------------------------------------- */

  const allowedCaps = SystemCapabilityMatrix[actor.name];
  const hasCap = allowedCaps.includes(capability);
  if (!hasCap) {
    if (config.capability_enforcement) {
      writeAuditEntry(siteId, denyEntry({
        correlationId,
        actor,
        capability,
        target: auditTarget,
        denyReason: 'capability_missing',
        metadata: auditMetadata,
      }));
      throw new SystemInvokerCapabilityDenied(actor.name, capability, correlationId);
    }
    // Kill switch off — proceed but stamp the audit so ops can see it.
    auditMetadata.enforcement_bypassed = 'capability';
  }

  /* -- rate limit ---------------------------------------------------------- */

  // Belt-and-braces: bucketForActor(SystemActor) returns 'system'. The
  // assertion here documents the intent that systemInvoker NEVER
  // contends for user-bucket tokens.
  if (bucketForActor(actor) !== 'system') {
    // Should be impossible — validateActor enforces actor.type === 'system'.
    throw new SystemInvokerInvalidActor('non-system actor reached rate-limit gate');
  }

  const rateLimitResult = await checkRateLimit(actor, capability, siteId);
  if (!rateLimitResult.ok) {
    if (config.rate_limit_enforcement) {
      writeAuditEntry(siteId, denyEntry({
        correlationId,
        actor,
        capability,
        target: auditTarget,
        denyReason: 'rate_limited',
        metadata: {
          ...auditMetadata,
          retryAfterSec: rateLimitResult.retryAfterSec,
        },
      }));
      throw new SystemInvokerRateLimited(rateLimitResult.retryAfterSec, correlationId);
    }
    // Kill switch off — annotate audit and proceed.
    if (auditMetadata.enforcement_bypassed) {
      auditMetadata.enforcement_bypassed = 'capability,rate_limit';
    } else {
      auditMetadata.enforcement_bypassed = 'rate_limit';
    }
  }

  /* -- allow audit (blocking) ---------------------------------------------- */

  const allowEntry: AuditEntryInput = {
    correlationId,
    actor: { type: 'system', name: actor.name },
    capability,
    target: auditTarget,
    outcome: 'allow',
    metadata: auditMetadata,
    enforcementBypassed: auditMetadata.enforcement_bypassed !== undefined ? true : undefined,
  };

  try {
    await writeAuditEntryBlocking(siteId, allowEntry);
  } catch (err) {
    // Audit unavailable — fail closed. A privileged action without a
    // record is unrecoverable forensically.
    logger.error('[systemInvoker] allow-audit write failed; refusing to invoke', {
      context: 'systemInvoker',
      data: {
        correlationId,
        actorName: actor.name,
        capability,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    throw new SystemInvokerAuditUnavailable(err, correlationId);
  }

  /* -- invoke -------------------------------------------------------------- */

  try {
    return await action({ actor, siteId, correlationId });
  } catch (err) {
    // Best-effort error-audit. Don't await — we want the original error
    // to surface immediately and the audit to land asynchronously.
    writeAuditEntry(siteId, {
      correlationId,
      actor: { type: 'system', name: actor.name },
      capability,
      target: auditTarget,
      outcome: 'error',
      errorCode: err instanceof Error ? err.name : 'UnknownError',
      metadata: {
        ...auditMetadata,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

interface DenyEntryArgs {
  correlationId: string;
  actor: SystemActor;
  capability: Capability;
  target: AuditTarget;
  denyReason: string;
  metadata?: Record<string, unknown>;
}

function denyEntry(args: DenyEntryArgs): AuditEntryInput {
  return {
    correlationId: args.correlationId,
    actor: { type: 'system', name: args.actor.name },
    capability: args.capability,
    target: args.target,
    outcome: 'deny',
    denyReason: args.denyReason,
    metadata: args.metadata,
  };
}

// Re-exported for tests / callers that want to derive their own paths.
export const __testables = {
  ALLOWED_CALLER_PATTERNS,
  isAllowedCaller,
  parseStackFrame,
};
