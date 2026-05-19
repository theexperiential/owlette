/** @jest-environment node */

/**
 * Unit tests for `web/lib/systemInvoker.server.ts` (security-boundary-migration
 * wave 2.3).
 *
 * Coverage:
 *   - happy path: allowed system actor + capability runs the action and
 *     produces an `allow` audit entry with `actor.type === 'system'`,
 *     `metadata.callerModule`, and the generated `correlationId`.
 *   - capability denied: capability not in `SystemCapabilityMatrix[name]`
 *     produces a `deny` audit entry, throws `SystemInvokerCapabilityDenied`,
 *     and never invokes `action`.
 *   - rate limited: `checkRateLimit` returns reject -> `deny` audit +
 *     `SystemInvokerRateLimited` thrown, action not invoked.
 *   - error propagation: action throws -> error audit (best-effort) +
 *     original error re-thrown unchanged.
 *   - audit-unavailable: blocking allow audit fails -> action NOT
 *     invoked, throws `SystemInvokerAuditUnavailable`.
 *   - kill switch: capability_enforcement off -> proceeds with
 *     enforcementBypassed flag; rate_limit_enforcement off ditto.
 *   - bucket isolation spot-check: confirms `checkRateLimit` is called
 *     with a system-typed actor (the rateLimit wave 1.4 tests own the
 *     full bucket-isolation matrix).
 *   - invalid actor: throws `SystemInvokerInvalidActor` synchronously,
 *     no audit row.
 *   - caller fingerprint: `metadata.callerModule` is a stable
 *     repo-relative string; an unexpected caller path emits a
 *     `UNEXPECTED_SYSTEM_INVOKER_CALLER` error log without throwing.
 */

import {
  invokeAsSystem,
  SystemInvokerCapabilityDenied,
  SystemInvokerRateLimited,
  SystemInvokerAuditUnavailable,
  SystemInvokerInvalidActor,
  captureCallerFingerprint,
  __testables,
} from '@/lib/systemInvoker.server';
import { Capability, type SystemActor } from '@/lib/capabilities';

/* -------------------------------------------------------------------------- */
/*  mocks                                                                     */
/* -------------------------------------------------------------------------- */

const blockingAuditCalls: Array<{ siteId: string; entry: Record<string, unknown> }> = [];
const fireAuditCalls: Array<{ siteId: string; entry: Record<string, unknown> }> = [];
let blockingAuditShouldReject: Error | null = null;
let blockingAuditCallCount = 0;

jest.mock('@/lib/auditLog.server', () => ({
  __esModule: true,
  generateCorrelationId: () => 'corr_test_fixed',
  writeAuditEntry: (siteId: string, entry: Record<string, unknown>) => {
    fireAuditCalls.push({ siteId, entry });
  },
  writeAuditEntryBlocking: async (siteId: string, entry: Record<string, unknown>) => {
    blockingAuditCallCount++;
    if (blockingAuditShouldReject) throw blockingAuditShouldReject;
    blockingAuditCalls.push({ siteId, entry });
  },
}));

const checkRateLimitSpy = jest.fn();

jest.mock('@/lib/rateLimit.server', () => ({
  __esModule: true,
  checkRateLimit: (...args: unknown[]) => checkRateLimitSpy(...args),
  bucketForActor: (actor: { type: string }) => (actor.type === 'system' ? 'system' : 'user'),
}));

const securityConfigReadSpy = jest.fn();
jest.mock('@/lib/securityConfig.server', () => ({
  __esModule: true,
  securityConfig: {
    read: () => securityConfigReadSpy(),
  },
}));

const loggerErrorSpy = jest.fn();
const loggerWarnSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => loggerWarnSpy(...args),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
  },
}));

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

const SITE = 'site-a';

function buildActor(overrides: Partial<SystemActor> = {}): SystemActor {
  return {
    type: 'system',
    name: 'cortex_autonomous',
    siteId: SITE,
    ...overrides,
  };
}

function defaultConfig() {
  return {
    capability_enforcement: true,
    rate_limit_enforcement: true,
    lastUpdated: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

beforeEach(() => {
  blockingAuditCalls.length = 0;
  fireAuditCalls.length = 0;
  blockingAuditShouldReject = null;
  blockingAuditCallCount = 0;
  checkRateLimitSpy.mockReset().mockResolvedValue({ ok: true });
  securityConfigReadSpy.mockReset().mockResolvedValue(defaultConfig());
  loggerErrorSpy.mockClear();
  loggerWarnSpy.mockClear();
});

/* -------------------------------------------------------------------------- */
/*  fingerprint helpers                                                       */
/* -------------------------------------------------------------------------- */

describe('captureCallerFingerprint', () => {
  it('skips frames pointing back at systemInvoker.server itself', () => {
    const stack = [
      'Error',
      '    at invokeAsSystem (/repo/web/lib/systemInvoker.server.ts:120:45)',
      '    at handler (/repo/web/lib/cortex/foo.ts:42:7)',
    ].join('\n');
    const fp = captureCallerFingerprint(stack);
    expect(fp).toBe('web/lib/cortex/foo.ts:42:7');
  });

  it('returns "unknown" when stack has no parseable frames', () => {
    expect(captureCallerFingerprint('')).toBe('unknown');
  });

  it('strips windows drive letters and backslashes', () => {
    const stack = [
      'Error',
      '    at invokeAsSystem (C:\\repo\\web\\lib\\systemInvoker.server.ts:1:1)',
      '    at fn (C:\\repo\\web\\lib\\cortex\\bar.ts:7:3)',
    ].join('\n');
    expect(captureCallerFingerprint(stack)).toBe('web/lib/cortex/bar.ts:7:3');
  });

  it('handles file:// urls (esm)', () => {
    const stack = [
      'Error',
      '    at invokeAsSystem (file:///repo/web/lib/systemInvoker.server.ts:1:1)',
      '    at fn (file:///repo/web/lib/jobs/cleanup.ts:9:5)',
    ].join('\n');
    expect(captureCallerFingerprint(stack)).toBe('web/lib/jobs/cleanup.ts:9:5');
  });
});

describe('isAllowedCaller', () => {
  it('accepts cortex paths', () => {
    expect(__testables.isAllowedCaller('web/lib/cortex/foo.ts:1:1')).toBe(true);
  });
  it('accepts jobs paths', () => {
    expect(__testables.isAllowedCaller('web/lib/jobs/cleanup.ts:1:1')).toBe(true);
  });
  it('accepts test paths via __tests__/', () => {
    expect(__testables.isAllowedCaller('web/__tests__/lib/systemInvoker.test.ts:1:1')).toBe(true);
  });
  it('accepts test files by .test.ts suffix', () => {
    expect(__testables.isAllowedCaller('some/random/path/foo.test.ts:1:1')).toBe(true);
  });
  it('rejects api routes', () => {
    expect(__testables.isAllowedCaller('web/app/api/sites/foo/route.ts:1:1')).toBe(false);
  });
  it('rejects unknown source', () => {
    expect(__testables.isAllowedCaller('unknown')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — happy path                                               */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — allow path', () => {
  it('runs action and writes an allow audit when capability is allowed', async () => {
    const action = jest.fn().mockResolvedValue('result');
    const result = await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action,
    });

    expect(result).toBe('result');
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({
      actor: expect.objectContaining({ type: 'system', name: 'cortex_autonomous' }),
      siteId: SITE,
      correlationId: 'corr_test_fixed',
    });

    expect(blockingAuditCalls).toHaveLength(1);
    const auditEntry = blockingAuditCalls[0].entry;
    expect(blockingAuditCalls[0].siteId).toBe(SITE);
    expect(auditEntry).toMatchObject({
      correlationId: 'corr_test_fixed',
      actor: { type: 'system', name: 'cortex_autonomous' },
      capability: Capability.MACHINE_EXEC_COMMAND,
      outcome: 'allow',
    });
    // siteId must NOT leak into the audit-actor shape (audit AuditActor
    // is the slim {type,name} variant).
    expect((auditEntry.actor as Record<string, unknown>).siteId).toBeUndefined();
    expect(((auditEntry as { metadata?: Record<string, unknown> }).metadata)?.callerModule).toBeDefined();
  });

  it('uses the system rate-limit bucket', async () => {
    await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action: async () => undefined,
    });
    expect(checkRateLimitSpy).toHaveBeenCalledTimes(1);
    const [actorArg] = checkRateLimitSpy.mock.calls[0];
    expect(actorArg.type).toBe('system');
    expect(actorArg.name).toBe('cortex_autonomous');
  });

  it('passes through caller-supplied metadata alongside callerModule', async () => {
    await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      metadata: { reason: 'autonomous-reaction', driftId: 'drift-7' },
      action: async () => undefined,
    });
    const meta = (blockingAuditCalls[0].entry as { metadata: Record<string, unknown> }).metadata;
    expect(meta.reason).toBe('autonomous-reaction');
    expect(meta.driftId).toBe('drift-7');
    expect(typeof meta.callerModule).toBe('string');
  });

  it('uses default site-kinded audit target when target omitted', async () => {
    await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action: async () => undefined,
    });
    expect((blockingAuditCalls[0].entry as { target: { kind: string; id: string } }).target).toEqual({
      kind: 'site',
      id: SITE,
    });
  });

  it('honors caller-supplied target', async () => {
    await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      target: { kind: 'machine', id: 'mach-1', machineId: 'mach-1' },
      action: async () => undefined,
    });
    expect((blockingAuditCalls[0].entry as { target: unknown }).target).toEqual({
      kind: 'machine',
      id: 'mach-1',
      machineId: 'mach-1',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — capability deny                                          */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — capability deny', () => {
  it('writes deny audit and throws when capability not in matrix', async () => {
    const action = jest.fn();
    await expect(
      invokeAsSystem({
        actor: buildActor({ name: 'cortex_provisioning' }), // empty allowlist
        capability: Capability.MACHINE_EXEC_COMMAND,
        siteId: SITE,
        action,
      }),
    ).rejects.toBeInstanceOf(SystemInvokerCapabilityDenied);

    expect(action).not.toHaveBeenCalled();
    expect(blockingAuditCalls).toHaveLength(0);
    expect(fireAuditCalls).toHaveLength(1);
    const denyEntry = fireAuditCalls[0].entry;
    expect(denyEntry).toMatchObject({
      outcome: 'deny',
      denyReason: 'capability_missing',
      correlationId: 'corr_test_fixed',
      actor: { type: 'system', name: 'cortex_provisioning' },
    });
  });

  it('skips audit + bypasses deny when capability_enforcement is off', async () => {
    securityConfigReadSpy.mockResolvedValue({
      capability_enforcement: false,
      rate_limit_enforcement: true,
      lastUpdated: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });

    const action = jest.fn().mockResolvedValue('ok');
    const result = await invokeAsSystem({
      actor: buildActor({ name: 'cortex_provisioning' }),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action,
    });
    expect(result).toBe('ok');
    expect(action).toHaveBeenCalled();
    expect(blockingAuditCalls).toHaveLength(1);
    const allowEntry = blockingAuditCalls[0].entry;
    expect(allowEntry.outcome).toBe('allow');
    expect((allowEntry as { enforcementBypassed?: boolean }).enforcementBypassed).toBe(true);
    expect(((allowEntry as { metadata: Record<string, unknown> }).metadata).enforcement_bypassed).toBe('capability');
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — rate limited                                             */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — rate limit', () => {
  it('writes deny audit and throws SystemInvokerRateLimited when limited', async () => {
    checkRateLimitSpy.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfterSec: 17 });
    const action = jest.fn();
    const promise = invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action,
    });
    await expect(promise).rejects.toBeInstanceOf(SystemInvokerRateLimited);
    await expect(promise).rejects.toMatchObject({ retryAfterSec: 17 });
    expect(action).not.toHaveBeenCalled();
    expect(fireAuditCalls).toHaveLength(1);
    expect(fireAuditCalls[0].entry).toMatchObject({
      outcome: 'deny',
      denyReason: 'rate_limited',
    });
    expect(((fireAuditCalls[0].entry as { metadata: Record<string, unknown> }).metadata).retryAfterSec).toBe(17);
  });

  it('bypasses rate-limit deny when rate_limit_enforcement is off', async () => {
    securityConfigReadSpy.mockResolvedValue({
      capability_enforcement: true,
      rate_limit_enforcement: false,
      lastUpdated: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    checkRateLimitSpy.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfterSec: 5 });

    const action = jest.fn().mockResolvedValue('go');
    const result = await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action,
    });
    expect(result).toBe('go');
    expect(blockingAuditCalls).toHaveLength(1);
    const meta = (blockingAuditCalls[0].entry as { metadata: Record<string, unknown> }).metadata;
    expect(meta.enforcement_bypassed).toBe('rate_limit');
  });

  it('combines bypass markers when both kill switches are off', async () => {
    securityConfigReadSpy.mockResolvedValue({
      capability_enforcement: false,
      rate_limit_enforcement: false,
      lastUpdated: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    checkRateLimitSpy.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfterSec: 1 });

    await invokeAsSystem({
      actor: buildActor({ name: 'cortex_provisioning' }),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action: async () => undefined,
    });
    const meta = (blockingAuditCalls[0].entry as { metadata: Record<string, unknown> }).metadata;
    expect(meta.enforcement_bypassed).toBe('capability,rate_limit');
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — error propagation                                        */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — error propagation', () => {
  it('writes error audit and re-throws when action throws', async () => {
    const boom = new Error('boom');
    boom.name = 'BoomError';
    await expect(
      invokeAsSystem({
        actor: buildActor(),
        capability: Capability.MACHINE_EXEC_COMMAND,
        siteId: SITE,
        action: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(blockingAuditCalls).toHaveLength(1); // allow row was written
    expect(fireAuditCalls).toHaveLength(1);
    expect(fireAuditCalls[0].entry).toMatchObject({
      outcome: 'error',
      errorCode: 'BoomError',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — audit unavailable                                        */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — audit unavailable', () => {
  it('refuses to invoke action when allow-audit write fails', async () => {
    blockingAuditShouldReject = new Error('firestore down');
    const action = jest.fn();
    await expect(
      invokeAsSystem({
        actor: buildActor(),
        capability: Capability.MACHINE_EXEC_COMMAND,
        siteId: SITE,
        action,
      }),
    ).rejects.toBeInstanceOf(SystemInvokerAuditUnavailable);

    expect(action).not.toHaveBeenCalled();
    expect(loggerErrorSpy).toHaveBeenCalled();
    // Allow audit was attempted exactly once (no retries).
    expect(blockingAuditCallCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — invalid actor                                            */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — invalid actor', () => {
  it('throws synchronously when actor.type is wrong', async () => {
    await expect(
      invokeAsSystem({
        // @ts-expect-error intentional bad input
        actor: { type: 'user', userId: 'u1', role: 'admin', sites: [SITE] },
        capability: Capability.MACHINE_EXEC_COMMAND,
        siteId: SITE,
        action: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(SystemInvokerInvalidActor);
    expect(blockingAuditCalls).toHaveLength(0);
  });

  it('throws when system actor name is unknown', async () => {
    await expect(
      invokeAsSystem({
        // @ts-expect-error intentional bad input
        actor: { type: 'system', name: 'mystery_actor', siteId: SITE },
        capability: Capability.MACHINE_EXEC_COMMAND,
        siteId: SITE,
        action: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(SystemInvokerInvalidActor);
  });

  it('throws when siteId is empty', async () => {
    await expect(
      invokeAsSystem({
        actor: buildActor(),
        capability: Capability.MACHINE_EXEC_COMMAND,
        siteId: '',
        action: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(SystemInvokerInvalidActor);
  });
});

/* -------------------------------------------------------------------------- */
/*  invokeAsSystem — unexpected caller alert                                  */
/* -------------------------------------------------------------------------- */

describe('invokeAsSystem — unexpected caller alert', () => {
  it('does not log error when caller is in allowed pattern', async () => {
    // The test file itself matches `__tests__/` pattern, so the natural
    // call here should NOT trigger the alert.
    await invokeAsSystem({
      actor: buildActor(),
      capability: Capability.MACHINE_EXEC_COMMAND,
      siteId: SITE,
      action: async () => undefined,
    });
    const sawUnexpectedCallerAlert = loggerErrorSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('UNEXPECTED_SYSTEM_INVOKER_CALLER'),
    );
    expect(sawUnexpectedCallerAlert).toBe(false);
  });
});
