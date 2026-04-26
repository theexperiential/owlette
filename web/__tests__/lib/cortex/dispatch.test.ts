/** @jest-environment node */

/**
 * Unit tests for `web/lib/cortex/dispatch.server.ts`
 * (security-boundary-migration wave 3.12).
 *
 * Verifies that every cortex_autonomous tool dispatch path:
 *   1. flows through `invokeAsSystem` with `actor.type === 'system'` +
 *      `actor.name === 'cortex_autonomous'` and capability
 *      `MACHINE_EXEC_COMMAND`
 *   2. calls `executeMachineCommand` so the audit correlation id is
 *      stamped into the firestore command
 *   3. propagates `cortexChatId` + `cortexEventId` into audit metadata
 *   4. polls the agent's response off the privileged frame and surfaces
 *      timeouts as `{ error: ... }` rather than throwing
 *   5. cleans up the pending entry on timeout (best-effort)
 *
 * The system rate-limit bucket isolation is enforced inside
 * `invokeAsSystem` itself and covered by `systemInvoker.test.ts`. This
 * suite asserts that the dispatch helpers are wired through that
 * pipeline (i.e. they call `invokeAsSystem` with a system-typed actor),
 * which is the contract `executeMachineCommand` migration depends on.
 */

import { Capability } from '@/lib/capabilities';

/* -------------------------------------------------------------------------- */
/*  mocks                                                                     */
/* -------------------------------------------------------------------------- */

interface InvokeArgs {
  actor: { type: string; name: string; siteId: string };
  capability: string;
  siteId: string;
  target?: { kind: string; id: string; machineId?: string };
  metadata?: Record<string, unknown>;
}

const invokeAsSystemSpy = jest.fn();
const FIXED_CORRELATION_ID = 'corr_dispatch_fixed';

jest.mock('@/lib/systemInvoker.server', () => ({
  __esModule: true,
  invokeAsSystem: async <T,>(opts: InvokeArgs & { action: (ctx: { actor: unknown; siteId: string; correlationId: string }) => Promise<T> }) => {
    invokeAsSystemSpy(opts);
    return opts.action({
      actor: opts.actor,
      siteId: opts.siteId,
      correlationId: FIXED_CORRELATION_ID,
    });
  },
}));

jest.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    static fromMillis(ms: number) {
      return { _ms: ms, isFakeTimestamp: true };
    }
    static now() {
      return { _ms: Date.now(), isFakeTimestamp: true };
    }
  }
  return {
    __esModule: true,
    FieldValue: {
      delete: () => '__FIELD_DELETE__',
      serverTimestamp: () => '__SERVER_TS__',
    },
    Timestamp: FakeTimestamp,
  };
});

jest.mock('@/lib/cortex-utils.server', () => ({
  __esModule: true,
  COMMAND_POLL_INTERVAL_MS: 0,
  COMMAND_TIMEOUT_MS: 30000,
}));

jest.mock('@/lib/auditLogClient', () => ({
  __esModule: true,
  emitMutation: jest.fn(),
}));

// executeMachineCommand uses Timestamp + FieldValue from firebase-admin/firestore.
// The above mock keeps it deterministic.

/* -------------------------------------------------------------------------- */
/*  fake firestore                                                            */
/* -------------------------------------------------------------------------- */

interface RecordedSet {
  path: string[];
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}
interface RecordedUpdate {
  path: string[];
  payload: Record<string, unknown>;
}

function buildFakeDb(opts: {
  /** Map of commandId -> result entry returned from `commands/completed`.get(). */
  completedResults?: Record<string, Record<string, unknown>>;
  /** When true, completedDoc.get() always returns `exists: false`. */
  completedAlwaysEmpty?: boolean;
}) {
  const sets: RecordedSet[] = [];
  const updates: RecordedUpdate[] = [];
  const completedResults = opts.completedResults ?? {};

  function makeCollection(parentPath: string[]): { doc: (id: string) => unknown } {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        return {
          set: jest.fn(
            async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
              sets.push({ path: docPath, payload, options });
            },
          ),
          update: jest.fn(async (payload: Record<string, unknown>) => {
            updates.push({ path: docPath, payload });
          }),
          get: jest.fn(async () => {
            if (docPath[docPath.length - 1] === 'completed') {
              if (opts.completedAlwaysEmpty) {
                return { exists: false, data: () => undefined };
              }
              return { exists: true, data: () => completedResults };
            }
            if (
              docPath.length === 4 &&
              docPath[0] === 'sites' &&
              docPath[2] === 'machines'
            ) {
              return { exists: true, data: () => ({ online: true }) };
            }
            return { exists: false, data: () => undefined };
          }),
          collection: (name: string) => makeCollection([...docPath, name]),
        };
      },
    };
  }

  return {
    db: { collection: (name: string) => makeCollection([name]) } as unknown as FirebaseFirestore.Firestore,
    sets,
    updates,
  };
}

/* -------------------------------------------------------------------------- */
/*  setup                                                                     */
/* -------------------------------------------------------------------------- */

import {
  dispatchToolCallAsSystem,
  dispatchExistingCommandAsSystem,
  type AutonomousDispatchContext,
} from '@/lib/cortex/dispatch.server';

const SITE_ID = 'site-A';
const MACHINE_ID = 'machine-1';
const CHAT_ID = 'auto_chat_42';
const EVENT_ID = 'evt_99';

beforeEach(() => {
  invokeAsSystemSpy.mockClear();
});

/* -------------------------------------------------------------------------- */
/*  dispatchToolCallAsSystem                                                  */
/* -------------------------------------------------------------------------- */

describe('dispatchToolCallAsSystem', () => {
  it('routes through invokeAsSystem with cortex_autonomous actor + MACHINE_EXEC_COMMAND', async () => {
    // Arrange a completed-doc that already contains a result so polling
    // returns immediately on first poll.
    const completedResults: Record<string, Record<string, unknown>> = {};
    const { db, sets } = buildFakeDb({
      completedResults: new Proxy(completedResults, {
        get: (_t, key) => {
          // Match any action-core command id so the first poll resolves.
          if (typeof key === 'string' && key.startsWith('cmd_')) {
            return { status: 'success', result: { hostname: 'box-1' } };
          }
          return undefined;
        },
      }),
    });

    const ctx: AutonomousDispatchContext = {
      db,
      siteId: SITE_ID,
      machineId: MACHINE_ID,
      chatId: CHAT_ID,
      eventId: EVENT_ID,
    };

    const result = await dispatchToolCallAsSystem(ctx, 'get_system_info', {});

    // Result is the parsed agent response.
    expect(result).toEqual({ hostname: 'box-1' });

    // invokeAsSystem was called exactly once with the right shape.
    expect(invokeAsSystemSpy).toHaveBeenCalledTimes(1);
    const args = invokeAsSystemSpy.mock.calls[0][0] as InvokeArgs;
    expect(args.actor).toEqual({
      type: 'system',
      name: 'cortex_autonomous',
      siteId: SITE_ID,
    });
    expect(args.capability).toBe(Capability.MACHINE_EXEC_COMMAND);
    expect(args.siteId).toBe(SITE_ID);
    expect(args.target).toEqual({
      kind: 'machine',
      id: MACHINE_ID,
      machineId: MACHINE_ID,
    });
    expect(args.metadata).toMatchObject({
      cortexChatId: CHAT_ID,
      cortexEventId: EVENT_ID,
      toolName: 'get_system_info',
      commandType: 'mcp_tool_call',
    });

    // The pending command was written with the audit correlation id and
    // the right shape.
    const pendingSets = sets.filter(
      (s) => s.path[s.path.length - 1] === 'pending',
    );
    expect(pendingSets).toHaveLength(1);
    const written = pendingSets[0].payload as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(written)[0];
    expect(cmdId).toMatch(/^cmd_/);
    expect(written[cmdId]).toMatchObject({
      type: 'mcp_tool_call',
      tool_name: 'get_system_info',
      tool_params: {},
      chat_id: CHAT_ID,
      status: 'pending',
      queuedBy: 'system:cortex_autonomous',
      auditCorrelationId: FIXED_CORRELATION_ID,
    });
  });

  it('passes tool_params through to the firestore command', async () => {
    const { db, sets } = buildFakeDb({
      completedResults: new Proxy({}, {
        get: () => ({ status: 'success', result: {} }),
      }) as Record<string, Record<string, unknown>>,
    });
    await dispatchToolCallAsSystem(
      { db, siteId: SITE_ID, machineId: MACHINE_ID, chatId: CHAT_ID, eventId: EVENT_ID },
      'get_running_processes',
      { name_filter: 'chrome', limit: 10 },
    );
    const pendingSet = sets.find((s) => s.path[s.path.length - 1] === 'pending')!;
    const written = pendingSet.payload as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(written)[0];
    expect(written[cmdId].tool_params).toEqual({ name_filter: 'chrome', limit: 10 });
  });

  it('returns an `error` envelope when the agent reports failure', async () => {
    const { db } = buildFakeDb({
      completedResults: new Proxy({}, {
        get: () => ({ status: 'failed', error: 'Process query timed out' }),
      }) as Record<string, Record<string, unknown>>,
    });
    const out = await dispatchToolCallAsSystem(
      { db, siteId: SITE_ID, machineId: MACHINE_ID, chatId: CHAT_ID, eventId: EVENT_ID },
      'get_system_info',
      {},
    );
    expect(out).toEqual({ error: 'Process query timed out' });
  });

  it('returns an `error` envelope on poll timeout and cleans up pending', async () => {
    const { db, updates } = buildFakeDb({ completedAlwaysEmpty: true });

    // Force the deadline-watch to fall through immediately by stubbing
    // Date.now into the future after the first invocation.
    const realNow = Date.now();
    let tick = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow + tick++ * 1_000_000);

    const out = await dispatchToolCallAsSystem(
      { db, siteId: SITE_ID, machineId: MACHINE_ID, chatId: CHAT_ID, eventId: EVENT_ID },
      'get_system_info',
      {},
    );
    expect(out).toMatchObject({ error: expect.stringContaining('timed out') });

    // Cleanup: a pending update with FieldValue.delete() was attempted.
    const pendingUpdates = updates.filter(
      (u) => u.path[u.path.length - 1] === 'pending',
    );
    expect(pendingUpdates.length).toBeGreaterThan(0);
    const deletePayload = pendingUpdates[0].payload;
    const fieldVals = Object.values(deletePayload);
    expect(fieldVals.some((v) => v === '__FIELD_DELETE__')).toBe(true);

    jest.restoreAllMocks();
  });
});

/* -------------------------------------------------------------------------- */
/*  dispatchExistingCommandAsSystem                                           */
/* -------------------------------------------------------------------------- */

describe('dispatchExistingCommandAsSystem', () => {
  it('routes through invokeAsSystem with cortex_autonomous actor', async () => {
    const { db, sets } = buildFakeDb({
      completedResults: new Proxy({}, {
        get: () => ({ status: 'success', result: 'Process restarted' }),
      }) as Record<string, Record<string, unknown>>,
    });

    const result = await dispatchExistingCommandAsSystem(
      { db, siteId: SITE_ID, machineId: MACHINE_ID, chatId: CHAT_ID, eventId: EVENT_ID },
      'restart_process',
      'MyApp.exe',
    );

    expect(result).toEqual({ status: 'success', result: 'Process restarted' });
    expect(invokeAsSystemSpy).toHaveBeenCalledTimes(1);

    const args = invokeAsSystemSpy.mock.calls[0][0] as InvokeArgs;
    expect(args.actor).toEqual({
      type: 'system',
      name: 'cortex_autonomous',
      siteId: SITE_ID,
    });
    expect(args.capability).toBe(Capability.MACHINE_EXEC_COMMAND);
    expect(args.metadata).toMatchObject({
      cortexChatId: CHAT_ID,
      cortexEventId: EVENT_ID,
      commandType: 'restart_process',
      processName: 'MyApp.exe',
    });

    const pendingSet = sets.find((s) => s.path[s.path.length - 1] === 'pending')!;
    const written = pendingSet.payload as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(written)[0];
    expect(cmdId).toMatch(/^cmd_/);
    expect(written[cmdId]).toMatchObject({
      type: 'restart_process',
      process_name: 'MyApp.exe',
      status: 'pending',
      queuedBy: 'system:cortex_autonomous',
      auditCorrelationId: FIXED_CORRELATION_ID,
    });
  });

  it('passes existing command params through to executeMachineCommand payload', async () => {
    const { db, sets } = buildFakeDb({
      completedResults: new Proxy({}, {
        get: () => ({ status: 'success', result: 'updated' }),
      }) as Record<string, Record<string, unknown>>,
    });

    await dispatchExistingCommandAsSystem(
      { db, siteId: SITE_ID, machineId: MACHINE_ID, chatId: CHAT_ID, eventId: EVENT_ID },
      'set_launch_mode',
      {
        process_name: 'TouchDesigner.exe',
        mode: 'scheduled',
        schedules: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }],
      },
    );

    const pendingSet = sets.find((s) => s.path[s.path.length - 1] === 'pending')!;
    const written = pendingSet.payload as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(written)[0];
    expect(written[cmdId]).toMatchObject({
      type: 'set_launch_mode',
      process_name: 'TouchDesigner.exe',
      mode: 'scheduled',
    });
    expect(written[cmdId].schedules).toEqual([
      { days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ]);
  });

  it('returns timeout envelope when agent does not respond', async () => {
    const { db } = buildFakeDb({ completedAlwaysEmpty: true });
    const realNow = Date.now();
    let tick = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow + tick++ * 1_000_000);

    const out = await dispatchExistingCommandAsSystem(
      { db, siteId: SITE_ID, machineId: MACHINE_ID, chatId: CHAT_ID, eventId: EVENT_ID },
      'reboot_machine',
      '',
    );
    expect(out).toEqual({ error: "Command 'reboot_machine' timed out" });

    jest.restoreAllMocks();
  });
});
