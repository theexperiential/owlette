/**
 * system invoker — the single entry point for acting as a system actor (hoot
 * autonomous, hoot provisioning, scheduled jobs). Mirrors `authorizedHandler`
 * so background work gets the same audit + rate-limit + kill-switch semantics.
 *
 * Order matters: validate actor → fingerprint caller → capability →
 * rate limit → BLOCKING allow-audit → action. The allow-audit is blocking and
 * fails closed: a privileged action with no audit record is unrecoverable
 * forensically. Errors inside `action` get a fire-and-forget error audit and
 * re-throw unchanged.
 *
 * Three layers keep callers honest: the `no-restricted-imports` eslint rule,
 * `scripts/check-system-invoker-callers.mjs` at ci, and the runtime
 * `UNEXPECTED_SYSTEM_INVOKER_CALLER` alert below if both are bypassed.
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

const KNOWN_SYSTEM_ACTOR_NAMES: ReadonlySet<string> = new Set<SystemActorName>([
  'cortex_autonomous',
  'cortex_provisioning',
  'scheduled_cleanup',
  'talon_runner',
]);

/**
 * Patterns the caller fingerprint must match; anything else logs
 * `UNEXPECTED_SYSTEM_INVOKER_CALLER`. Matched against the forward-slash
 * normalized path; test paths are listed so unit tests don't trip the alert.
 */
const ALLOWED_CALLER_PATTERNS: readonly RegExp[] = [
  /(^|\/)web\/lib\/hoot\//,
  /(^|\/)web\/lib\/jobs\//,
  /(^|\/)web\/__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

/**
 * Repo-relative fingerprint of `invokeAsSystem`'s immediate caller: first
 * stack frame that isn't this file, with absolute prefixes stripped so it is
 * stable across machines. `unknown` when the stack can't be parsed (minified
 * production builds).
 */
export function captureCallerFingerprint(stackOverride?: string): string {
  const stack = stackOverride ?? new Error().stack ?? '';
  const lines = stack.split('\n');
  for (const rawLine of lines) {
    const frame = parseStackFrame(rawLine);
    if (!frame) continue;
    if (frame.includes('systemInvoker.server')) continue;
    return frame;
  }
  return 'unknown';
}

/**
 * Source location from one v8 stack frame, forward-slashed and repo-relative.
 * Handles both `at Foo (C:/repo/web/lib/x.ts:12:34)` and the bare-path form.
 */
function parseStackFrame(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ')) return null;
  const parenMatch = trimmed.match(/\(([^)]+)\)\s*$/);
  const loc = parenMatch ? parenMatch[1] : trimmed.slice(3); // strip "at "
  if (!loc || loc === 'native' || loc.startsWith('<anonymous>')) return null;

  let normalized = loc.replace(/^file:\/\/\/?/, ''); // esm file:// prefix
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/^[A-Za-z]:\//, '/'); // windows drive letter

  // The repo root isn't knowable statically, but `web/`, `agent/`, `scripts/`
  // are stable suffixes — trim everything before one.
  const repoIdx = findRepoRelativeStart(normalized);
  if (repoIdx >= 0) normalized = normalized.slice(repoIdx);

  return normalized;
}

function findRepoRelativeStart(p: string): number {
  // Rightmost match, so `/foo/web/.../web/lib/...` resolves to the deepest one.
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
  // Strip the line:column suffix so `/web/lib/hoot/foo.ts:12:3` still matches.
  const sourcePath = fingerprint.replace(/:\d+:\d+$/, '');
  return ALLOWED_CALLER_PATTERNS.some((re) => re.test(sourcePath));
}

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

/**
 * Run `action` as a system actor with full audit + capability + rate-limit
 * mediation (pipeline in the module doc). Throws a `SystemInvoker*` error for
 * anything that prevents the action running; errors from inside `action` are
 * re-thrown unchanged after a best-effort error audit.
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
    // Third layer: fires only if eslint + the ci scan were both bypassed.
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

  // Read once per call so capability + rate-limit see the same kill-switch view.
  const config = await securityConfig.read();

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

  // systemInvoker must never contend for user-bucket tokens. Unreachable —
  // validateActor already enforces actor.type === 'system'.
  if (bucketForActor(actor) !== 'system') {
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
    // Fail closed: a privileged action with no audit record is unrecoverable.
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

  try {
    return await action({ actor, siteId, correlationId });
  } catch (err) {
    // Not awaited: the original error must surface immediately.
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
