/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.mock('@/lib/apiAuth.server', () => {
  class _ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireAdminOrIdToken: jest.fn().mockResolvedValue('test-admin'),
    assertUserHasSiteAccess: jest.fn().mockResolvedValue({ siteId: 's1', siteData: {} }),
    ApiAuthError: _ApiAuthError,
  };
});

const { requireAdminOrIdToken, assertUserHasSiteAccess, ApiAuthError } =
  jest.requireMock('@/lib/apiAuth.server');

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: mockGet,
        set: mockSet,
        update: mockUpdate,
        collection: () => ({
          doc: () => ({
            get: mockGet,
            set: mockSet,
            update: mockUpdate,
            collection: () => ({
              doc: () => ({
                get: mockGet,
                set: mockSet,
                update: mockUpdate,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { POST } from '@/app/api/admin/tools/execute/route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/tools/execute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/admin/tools/execute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAdminOrIdToken as jest.Mock).mockResolvedValue('test-admin');
    (assertUserHasSiteAccess as jest.Mock).mockResolvedValue({ siteId: 's1', siteData: {} });
  });

  // ── Validation ──────────────────────────────────────────────────────────

  it('returns 400 when siteId is missing', async () => {
    const res = await POST(makeRequest({ machineId: 'm1', tool: 'get_system_info' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/siteId/);
  });

  it('returns 400 when machineId is missing', async () => {
    const res = await POST(makeRequest({ siteId: 's1', tool: 'get_system_info' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/machineId/);
  });

  it('returns 400 when tool is missing', async () => {
    const res = await POST(makeRequest({ siteId: 's1', machineId: 'm1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tool/i);
  });

  it('returns 400 for unknown tool name', async () => {
    const res = await POST(
      makeRequest({ siteId: 's1', machineId: 'm1', tool: 'hack_the_planet' })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/Unknown tool/);
  });

  it('returns 400 when required params are missing', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        tool: 'run_command',
        params: {},  // missing required 'command'
      })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/command/);
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  it('returns 401 when unauthorized', async () => {
    (requireAdminOrIdToken as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );
    const res = await POST(
      makeRequest({ siteId: 's1', machineId: 'm1', tool: 'get_system_info' })
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks site access', async () => {
    (assertUserHasSiteAccess as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(403, 'No access to site')
    );
    const res = await POST(
      makeRequest({ siteId: 's1', machineId: 'm1', tool: 'get_system_info' })
    );
    expect(res.status).toBe(403);
  });

  // ── Successful execution (wait=false) ─────────────────────────────────

  it('sends mcp_tool_call for tier 1 tool and returns immediately', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        tool: 'get_system_info',
        wait: false,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.commandId).toBeDefined();
    expect(json.tool).toBe('get_system_info');
    expect(json.tier).toBe(1);

    // Verify Firestore write
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        [json.commandId]: expect.objectContaining({
          type: 'mcp_tool_call',
          tool_name: 'get_system_info',
          tool_params: {},
          status: 'pending',
        }),
      }),
      { merge: true }
    );
  });

  it('sends existing command for tier 2 tool (restart_process)', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        tool: 'restart_process',
        params: { process_name: 'MyApp.exe' },
        wait: false,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier).toBe(2);

    // Tier 2 uses existing command system, not mcp_tool_call
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        [json.commandId]: expect.objectContaining({
          type: 'restart_process',
          process_name: 'MyApp.exe',
          status: 'pending',
        }),
      }),
      { merge: true }
    );
  });

  it('sends mcp_tool_call for tier 3 tool with params', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        tool: 'run_command',
        params: { command: 'ipconfig /all' },
        wait: false,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier).toBe(3);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        [json.commandId]: expect.objectContaining({
          type: 'mcp_tool_call',
          tool_name: 'run_command',
          tool_params: { command: 'ipconfig /all' },
        }),
      }),
      { merge: true }
    );
  });

  // ── Parameterless tools ───────────────────────────────────────────────

  it('accepts parameterless tools without params field', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        tool: 'get_disk_usage',
        wait: false,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tool).toBe('get_disk_usage');
    expect(json.tier).toBe(1);
  });

  // ── All tool names accepted ───────────────────────────────────────────

  const allToolNames = [
    'get_system_info', 'get_process_list', 'get_running_processes',
    'get_network_info', 'get_disk_usage', 'get_event_logs',
    'get_service_status', 'get_agent_config', 'get_agent_logs',
    'get_agent_health', 'restart_process', 'kill_process',
    'start_process', 'set_launch_mode', 'capture_screenshot',
    'run_command', 'run_powershell', 'run_python', 'execute_script',
    'read_file', 'write_file', 'list_directory',
    'reboot_machine', 'shutdown_machine', 'cancel_reboot',
  ];

  // Build params that satisfy required fields for each tool
  const toolParamsMap: Record<string, Record<string, unknown>> = {
    get_service_status: { service_name: 'OwletteService' },
    restart_process: { process_name: 'Test.exe' },
    kill_process: { process_name: 'Test.exe' },
    start_process: { process_name: 'Test.exe' },
    set_launch_mode: { process_name: 'Test.exe', mode: 'always' },
    run_command: { command: 'hostname' },
    run_powershell: { script: 'Get-Process' },
    run_python: { code: 'print("hello")' },
    execute_script: { script: 'Get-ComputerInfo' },
    read_file: { path: 'C:\\test.txt' },
    write_file: { path: 'C:\\test.txt', content: 'hello' },
    list_directory: { path: 'C:\\' },
  };

  it.each(allToolNames)('accepts tool: %s', async (toolName) => {
    const params = toolParamsMap[toolName] || {};
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        tool: toolName,
        params,
        wait: false,
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.tool).toBe(toolName);
  });
});
