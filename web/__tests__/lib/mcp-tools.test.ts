/** @jest-environment node */

import {
  allTools,
  getToolsByTier,
  getToolByName,
  toAISDKTools,
  requiresConfirmation,
  EXISTING_COMMAND_MAPPINGS,
  type McpToolDefinition,
} from '@/lib/mcp-tools';

// ─── Tool Registry ──────────────────────────────────────────────────────────
// Single source of truth: every tool name that must exist.
// If a tool is added/removed in mcp-tools.ts, this list must be updated.

const EXPECTED_TIER1 = [
  'get_site_logs',
  'get_system_info',
  'get_process_list',
  'get_running_processes',
  'get_gpu_processes',
  'get_network_info',
  'get_disk_usage',
  'get_event_logs',
  'get_service_status',
  'get_agent_config',
  'get_agent_logs',
  'get_agent_health',
  'get_system_presets',
  'check_pending_reboot',
] as const;

const EXPECTED_TIER2 = [
  'restart_process',
  'kill_process',
  'start_process',
  'set_launch_mode',
  'capture_screenshot',
  // Wave 1
  'manage_process',
  'manage_windows_service',
  'configure_gpu_tdr',
  'manage_windows_update',
  'manage_notifications',
  'configure_power_plan',
  // Wave 2
  'manage_scheduled_task',
  'network_reset',
  'registry_operation',
  'clean_disk_space',
  'get_event_logs_filtered',
  'manage_windows_feature',
  'show_notification',
] as const;

const EXPECTED_TIER3 = [
  'run_command',
  'run_powershell',
  'run_python',
  'execute_script',
  'read_file',
  'write_file',
  'list_directory',
  'deploy_software',
  'reboot_machine',
  'shutdown_machine',
  'cancel_reboot',
] as const;

const ALL_EXPECTED = [...EXPECTED_TIER1, ...EXPECTED_TIER2, ...EXPECTED_TIER3];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('mcp-tools: tool definitions', () => {
  it('exports exactly the expected number of tools', () => {
    expect(allTools).toHaveLength(ALL_EXPECTED.length);
  });

  it('every expected tool exists in allTools', () => {
    const names = allTools.map((t) => t.name);
    for (const expected of ALL_EXPECTED) {
      expect(names).toContain(expected);
    }
  });

  it('has no duplicate tool names', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(allTools.map((t) => [t.name, t]))('%s has valid schema', (_name, tool) => {
    const t = tool as McpToolDefinition;
    expect(t.name).toBeTruthy();
    expect(t.description).toBeTruthy();
    expect(t.description.length).toBeGreaterThan(10);
    expect([1, 2, 3]).toContain(t.tier);
    expect(t.parameters).toBeDefined();
    expect(t.parameters.type).toBe('object');
    expect(t.parameters.properties).toBeDefined();
  });
});

describe('mcp-tools: tier assignments', () => {
  it.each(EXPECTED_TIER1.map((n) => [n]))('%s is tier 1', (name) => {
    expect(getToolByName(name)?.tier).toBe(1);
  });

  it.each(EXPECTED_TIER2.map((n) => [n]))('%s is tier 2', (name) => {
    expect(getToolByName(name)?.tier).toBe(2);
  });

  it.each(EXPECTED_TIER3.map((n) => [n]))('%s is tier 3', (name) => {
    expect(getToolByName(name)?.tier).toBe(3);
  });
});

describe('mcp-tools: getToolsByTier()', () => {
  it('tier 1 returns only read-only tools', () => {
    const tools = getToolsByTier(1);
    expect(tools).toHaveLength(EXPECTED_TIER1.length);
    expect(tools.every((t) => t.tier === 1)).toBe(true);
  });

  it('tier 2 includes tier 1 + process management', () => {
    const tools = getToolsByTier(2);
    expect(tools).toHaveLength(EXPECTED_TIER1.length + EXPECTED_TIER2.length);
    expect(tools.every((t) => t.tier <= 2)).toBe(true);
  });

  it('tier 3 returns all tools', () => {
    const tools = getToolsByTier(3);
    expect(tools).toHaveLength(ALL_EXPECTED.length);
  });
});

describe('mcp-tools: getToolByName()', () => {
  it('returns the correct tool', () => {
    const tool = getToolByName('get_system_info');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_system_info');
    expect(tool!.tier).toBe(1);
  });

  it('returns undefined for unknown tools', () => {
    expect(getToolByName('nonexistent_tool')).toBeUndefined();
  });
});

describe('mcp-tools: toAISDKTools()', () => {
  it('converts all tools to AI SDK format', () => {
    const sdkTools = toAISDKTools(allTools);
    const keys = Object.keys(sdkTools);
    expect(keys).toHaveLength(allTools.length);
    for (const tool of allTools) {
      expect(sdkTools[tool.name]).toBeDefined();
      expect(sdkTools[tool.name].description).toBe(tool.description);
      expect(sdkTools[tool.name].parameters).toBe(tool.parameters);
    }
  });
});

describe('mcp-tools: requiresConfirmation()', () => {
  it('tier 1 tools do not require confirmation', () => {
    for (const name of EXPECTED_TIER1) {
      expect(requiresConfirmation(name)).toBe(false);
    }
  });

  it('tier 2 tools do not require confirmation', () => {
    for (const name of EXPECTED_TIER2) {
      expect(requiresConfirmation(name)).toBe(false);
    }
  });

  it('tier 3 tools require confirmation', () => {
    for (const name of EXPECTED_TIER3) {
      expect(requiresConfirmation(name)).toBe(true);
    }
  });

  it('unknown tools require confirmation (safe default)', () => {
    expect(requiresConfirmation('something_unknown')).toBe(true);
  });
});

describe('mcp-tools: EXISTING_COMMAND_MAPPINGS', () => {
  it('maps only to valid command types', () => {
    for (const [toolName, cmdType] of Object.entries(EXISTING_COMMAND_MAPPINGS)) {
      expect(typeof toolName).toBe('string');
      expect(typeof cmdType).toBe('string');
      expect(cmdType.length).toBeGreaterThan(0);
    }
  });

  it('every mapped tool exists in allTools', () => {
    for (const toolName of Object.keys(EXISTING_COMMAND_MAPPINGS)) {
      expect(getToolByName(toolName)).toBeDefined();
    }
  });
});

describe('mcp-tools: required parameters', () => {
  it('get_service_status requires service_name', () => {
    const tool = getToolByName('get_service_status')!;
    expect(tool.parameters.required).toContain('service_name');
  });

  it('run_command requires command', () => {
    const tool = getToolByName('run_command')!;
    expect(tool.parameters.required).toContain('command');
  });

  it('run_powershell requires script', () => {
    const tool = getToolByName('run_powershell')!;
    expect(tool.parameters.required).toContain('script');
  });

  it('read_file requires path', () => {
    const tool = getToolByName('read_file')!;
    expect(tool.parameters.required).toContain('path');
  });

  it('write_file requires path and content', () => {
    const tool = getToolByName('write_file')!;
    expect(tool.parameters.required).toContain('path');
    expect(tool.parameters.required).toContain('content');
  });

  it('list_directory requires path', () => {
    const tool = getToolByName('list_directory')!;
    expect(tool.parameters.required).toContain('path');
  });

  it('execute_script requires script', () => {
    const tool = getToolByName('execute_script')!;
    expect(tool.parameters.required).toContain('script');
  });

  it('run_python requires code', () => {
    const tool = getToolByName('run_python')!;
    expect(tool.parameters.required).toContain('code');
  });

  it('restart_process requires process_name', () => {
    const tool = getToolByName('restart_process')!;
    expect(tool.parameters.required).toContain('process_name');
  });

  it('deploy_software requires software_name', () => {
    const tool = getToolByName('deploy_software')!;
    expect(tool.parameters.required).toContain('software_name');
  });

  it('parameterless tools have no required fields', () => {
    const noParams = ['get_system_info', 'get_process_list', 'get_network_info', 'get_disk_usage', 'get_agent_config', 'get_agent_health', 'reboot_machine', 'shutdown_machine', 'cancel_reboot'];
    for (const name of noParams) {
      const tool = getToolByName(name)!;
      expect(tool.parameters.required ?? []).toHaveLength(0);
    }
  });
});

// ─── Agent Parity Check ─────────────────────────────────────────────────────
// These are the tools implemented in agent/src/mcp_tools.py execute_tool().
// Tier 2 tools go through IPC, not mcp_tools.py — they use existing commands.
// This test ensures the web definitions match what the agent actually handles.

describe('mcp-tools: agent parity', () => {
  // Tools handled directly by mcp_tools.execute_tool()
  const AGENT_MCP_TOOLS = [
    'get_system_info', 'get_process_list', 'get_running_processes',
    'get_network_info', 'get_disk_usage', 'get_event_logs',
    'get_service_status', 'get_agent_config', 'get_agent_logs',
    'get_agent_health', 'run_command', 'run_powershell',
    'execute_script', 'read_file', 'write_file', 'list_directory',
  ];

  it('all agent mcp_tools handlers have web definitions', () => {
    for (const name of AGENT_MCP_TOOLS) {
      expect(getToolByName(name)).toBeDefined();
    }
  });

  // Tools routed via IPC or existing command system (not in mcp_tools.py)
  const IPC_TOOLS = ['restart_process', 'kill_process', 'start_process', 'set_launch_mode', 'capture_screenshot'];
  const SERVICE_TOOLS = ['reboot_machine', 'shutdown_machine', 'cancel_reboot', 'run_python'];

  it('IPC tools are tier 2', () => {
    for (const name of IPC_TOOLS) {
      expect(getToolByName(name)?.tier).toBe(2);
    }
  });

  it('service-level tools are tier 3', () => {
    for (const name of SERVICE_TOOLS) {
      expect(getToolByName(name)?.tier).toBe(3);
    }
  });

  // Server-side tools (executed on web server, not relayed to agent)
  const SERVER_SIDE_TOOLS = ['get_site_logs', 'get_system_presets', 'deploy_software'];

  it('server-side tools have web definitions', () => {
    for (const name of SERVER_SIDE_TOOLS) {
      expect(getToolByName(name)).toBeDefined();
    }
  });
});
