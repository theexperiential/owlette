/** @jest-environment node */

/**
 * Tests for cortex-utils.server.ts — the tool execution relay layer.
 *
 * Verifies: executeToolOnAgent, executeExistingCommand, buildExecutableTools.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('ai', () => ({
  tool: jest.fn((opts: unknown) => opts),
  jsonSchema: jest.fn((s: unknown) => s),
}));

jest.mock('@/lib/llm-encryption.server', () => ({
  decryptApiKey: jest.fn((v: string) => v),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: jest.fn(() => '__FIELD_DELETE__') },
}));

// ─── Mock Firestore ─────────────────────────────────────────────────────────
// Path: sites/{s}/machines/{m}/commands/pending|completed

function createMockDb() {
  const completedDoc = {
    get: jest.fn(async () => ({ exists: false, data: () => ({}) })),
    update: jest.fn(async () => {}),
  };

  const pendingDoc = {
    set: jest.fn<Promise<void>, [data: Record<string, unknown>, options?: unknown]>(async () => {}),
    update: jest.fn<Promise<void>, [data: Record<string, unknown>]>(async () => {}),
  };

  function buildDoc(): Record<string, unknown> {
    return {
      get: jest.fn(),
      set: jest.fn(),
      update: jest.fn(),
      collection: jest.fn((name: string) => {
        if (name === 'commands') {
          return {
            doc: jest.fn((docId: string) => {
              if (docId === 'pending') return pendingDoc;
              if (docId === 'completed') return completedDoc;
              return buildDoc();
            }),
          };
        }
        return { doc: jest.fn(() => buildDoc()) };
      }),
    };
  }

  return {
    db: { collection: jest.fn(() => ({ doc: jest.fn(() => buildDoc()) })) } as unknown as FirebaseFirestore.Firestore,
    pendingDoc,
    completedDoc,
  };
}

/** Extract the first command ID written to pendingDoc.set */
function getCommandId(pendingDoc: { set: jest.Mock }): string {
  const firstCallArg = pendingDoc.set.mock.calls[0]?.[0] || {};
  return Object.keys(firstCallArg)[0] || '';
}

import {
  executeToolOnAgent,
  executeExistingCommand,
  buildExecutableTools,
  verifyUserSiteAccess,
  resolveCortexMaxTier,
  COMMAND_TIMEOUT_MS,
} from '@/lib/cortex-utils.server';

import { allTools } from '@/lib/mcp-tools';

// ─── executeToolOnAgent ─────────────────────────────────────────────────────

describe('executeToolOnAgent', () => {
  beforeEach(() => jest.useRealTimers());

  it('writes mcp_tool_call to pending and returns result', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({
          [cmdId]: { status: 'success', result: { hostname: 'test-box' } },
        }),
      };
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'get_system_info', {}, 'chat1');

    // Verify the pending write
    expect(pendingDoc.set).toHaveBeenCalledTimes(1);
    const written = pendingDoc.set.mock.calls[0][0];
    const cmdId = Object.keys(written)[0];
    expect(cmdId).toMatch(/^mcp_/);
    expect(written[cmdId]).toMatchObject({
      type: 'mcp_tool_call',
      tool_name: 'get_system_info',
      tool_params: {},
      chat_id: 'chat1',
      status: 'pending',
    });

    // Verify result
    expect(result).toMatchObject({ hostname: 'test-box' });
  });

  it('returns error when tool execution fails', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({
          [cmdId]: { status: 'failed', error: 'Process query timed out' },
        }),
      };
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'get_running_processes', { limit: 50 }, 'c1');
    expect(result).toEqual({ error: 'Process query timed out' });
  });

  it('returns timeout error when agent never responds', async () => {
    const { db, completedDoc } = createMockDb();

    completedDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });

    // Fast-forward through the poll loop by mocking Date.now
    const realNow = Date.now();
    let tick = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      // Each call advances past the timeout
      return realNow + (tick++ * COMMAND_TIMEOUT_MS);
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'get_system_info', {}, 'c1');

    expect(result).toMatchObject({ error: expect.stringContaining('timed out') });
    jest.restoreAllMocks();
  });

  it('passes tool_params through to the command', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    await executeToolOnAgent(db, 's1', 'm1', 'get_running_processes', { name_filter: 'chrome', limit: 10 }, 'c1');

    const written = pendingDoc.set.mock.calls[0][0] as Record<string, { tool_params: Record<string, unknown> }>;
    const cmdId = Object.keys(written)[0];
    expect(written[cmdId].tool_params).toEqual({ name_filter: 'chrome', limit: 10 });
  });
});

// ─── executeExistingCommand ─────────────────────────────────────────────────

describe('executeExistingCommand', () => {
  it('writes legacy command and returns result', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({ [cmdId]: { status: 'success', result: 'Process restarted' } }),
      };
    });

    const result = await executeExistingCommand(db, 's1', 'm1', 'restart_process', 'MyApp.exe');

    // Verify command format
    const written = pendingDoc.set.mock.calls[0][0];
    const cmdId = Object.keys(written)[0];
    expect(cmdId).toMatch(/^restart_process_/);
    expect(written[cmdId]).toMatchObject({
      type: 'restart_process',
      process_name: 'MyApp.exe',
      status: 'pending',
    });

    expect(result).toMatchObject({ status: 'success' });
  });
});

// ─── buildExecutableTools ───────────────────────────────────────────────────

describe('buildExecutableTools', () => {
  it('creates an executable tool for each definition', () => {
    const tools = buildExecutableTools({} as unknown as FirebaseFirestore.Firestore, 's1', 'm1', 'c1', allTools);

    expect(Object.keys(tools)).toHaveLength(allTools.length);
    for (const def of allTools) {
      expect(tools[def.name]).toBeDefined();
      expect(tools[def.name].description).toBe(def.description);
    }
  });

  it('site mode creates tools for fan-out execution', () => {
    const tools = buildExecutableTools({} as unknown as FirebaseFirestore.Firestore, 's1', '', 'c1', allTools, true, ['m1', 'm2']);
    expect(Object.keys(tools)).toHaveLength(allTools.length);
  });
});

// ─── verifyUserSiteAccess ───────────────────────────────────────────────────

/**
 * Build a db stub whose `collection(name).doc(id).get()` resolves to the
 * data in `docs[name]`. Absent entries return `{ exists: false }`.
 */
function makeAccessDb(docs: {
  users?: Record<string, unknown> | null;
  sites?: Record<string, unknown> | null;
  siteExists?: boolean;
}) {
  return {
    collection: (name: string) => ({
      doc: (_id: string) => ({
        get: async () => {
          if (name === 'users') {
            return docs.users
              ? { exists: true, data: () => docs.users }
              : { exists: false, data: () => undefined };
          }
          if (name === 'sites') {
            if (docs.siteExists === false) {
              return { exists: false };
            }
            return { exists: true, data: () => docs.sites ?? {} };
          }
          return { exists: false };
        },
      }),
    }),
  } as unknown as FirebaseFirestore.Firestore;
}

describe('verifyUserSiteAccess', () => {
  it('throws when the user doc does not exist', async () => {
    const db = makeAccessDb({ users: null, sites: { owner: 'someone' } });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow('User not found');
  });

  it('throws when the site doc does not exist', async () => {
    const db = makeAccessDb({ users: { role: 'member', sites: ['s1'] }, siteExists: false });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow('Site not found');
  });

  it('grants superadmin full access with isSiteAdmin=true', async () => {
    const db = makeAccessDb({
      users: { role: 'superadmin', sites: [] },
      sites: { owner: 'someone' },
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSuperadmin).toBe(true);
    expect(access.isSiteAdmin).toBe(true);
  });

  it('grants a freshly-created site owner access even without sites[] entry', async () => {
    // Regression: previously rejected fresh owners because the user doc's
    // sites[] array is not updated on site creation.
    const db = makeAccessDb({
      users: { role: 'admin', sites: [] },
      sites: { owner: 'u1' },
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSiteOwner).toBe(true);
    expect(access.isSiteAdmin).toBe(true);
  });

  it('grants admin role with site assignment isSiteAdmin=true', async () => {
    const db = makeAccessDb({
      users: { role: 'admin', sites: ['s1'] },
      sites: { owner: 'other' },
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSiteAdmin).toBe(true);
  });

  it('grants member with assignment site access but NOT admin', async () => {
    const db = makeAccessDb({
      users: { role: 'member', sites: ['s1'] },
      sites: { owner: 'other' },
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSiteAdmin).toBe(false);
    expect(access.role).toBe('member');
  });

  it('grants member-owner site access but NOT admin', async () => {
    const db = makeAccessDb({
      users: { role: 'member', sites: [] },
      sites: { owner: 'u1' },
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSiteOwner).toBe(true);
    expect(access.isSiteAdmin).toBe(false);
  });

  it('rejects users who are not superadmin/owner/assigned', async () => {
    const db = makeAccessDb({
      users: { role: 'member', sites: ['other'] },
      sites: { owner: 'other' },
    });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow(
      /do not have access/
    );
  });
});

// ─── resolveCortexMaxTier ───────────────────────────────────────────────────

describe('resolveCortexMaxTier', () => {
  it('returns 3 for site admins', () => {
    expect(
      resolveCortexMaxTier({ role: 'superadmin', isSuperadmin: true, isSiteAdmin: true, isSiteOwner: false })
    ).toBe(3);
    expect(
      resolveCortexMaxTier({ role: 'admin', isSuperadmin: false, isSiteAdmin: true, isSiteOwner: true })
    ).toBe(3);
  });

  it('caps non-admins (members) at tier 1 — read-only', () => {
    // Regression: members with site access must not receive tier 2/3 tools,
    // which include registry writes, execute_script, run_powershell, etc.
    expect(
      resolveCortexMaxTier({ role: 'member', isSuperadmin: false, isSiteAdmin: false, isSiteOwner: true })
    ).toBe(1);
    expect(
      resolveCortexMaxTier({ role: 'member', isSuperadmin: false, isSiteAdmin: false, isSiteOwner: false })
    ).toBe(1);
  });
});
