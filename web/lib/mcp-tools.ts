/**
 * MCP Tool definitions for the Owlette chat interface.
 *
 * These schemas are shared between:
 * - The chat API route (passed to Claude/OpenAI as tool definitions)
 * - The chat UI (for rendering tool call cards)
 *
 * Tools are organized into tiers:
 * - Tier 1: Read-only (auto-approved)
 * - Tier 2: Process management (auto-approved, wraps existing commands)
 * - Tier 3: Privileged (require user confirmation in chat UI)
 */

export type ToolTier = 1 | 2 | 3;

export interface McpToolDefinition {
  name: string;
  description: string;
  tier: ToolTier;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      default?: unknown;
      items?: any;
    }>;
    required?: string[];
  };
}

// ─── Tier 1: Read-Only Tools ────────────────────────────────────────────────

const tier1Tools: McpToolDefinition[] = [
  {
    name: 'get_system_info',
    description: 'Get comprehensive system information: hostname, OS (with correct Windows 10/11 detection), CPU model and usage, memory (used/total GB), disk (used/total GB), GPU model, GPU driver version, VRAM (used/total GB), GPU load %, system uptime, and agent version. Use this as the first step for any hardware or system questions.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_process_list',
    description: 'Get all Owlette-configured processes with their current status, PID, autolaunch setting, and whether they are running.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_running_processes',
    description: 'Get all running OS processes with CPU and memory usage. Can filter by name. Returns top processes sorted by memory usage.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        name_filter: {
          type: 'string',
          description: 'Optional filter — only return processes whose name contains this string (case-insensitive).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of processes to return (default: 50, max: 200).',
          default: 50,
        },
      },
    },
  },
  {
    name: 'get_network_info',
    description: 'Get network interfaces with IP addresses, netmasks, and link status.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_disk_usage',
    description: 'Get disk usage for all drives including total, used, free space and percentage.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_event_logs',
    description: 'Get Windows event log entries from Application, System, or Security logs. Can filter by severity level.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        log_name: {
          type: 'string',
          description: 'Which event log to query.',
          enum: ['Application', 'System', 'Security'],
          default: 'Application',
        },
        max_events: {
          type: 'number',
          description: 'Maximum number of events to return (default: 20, max: 100).',
          default: 20,
        },
        level: {
          type: 'string',
          description: 'Filter by severity level.',
          enum: ['Error', 'Warning', 'Information'],
        },
      },
    },
  },
  {
    name: 'get_service_status',
    description: 'Get the status of a Windows service by name (running, stopped, paused, etc.).',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        service_name: {
          type: 'string',
          description: 'The Windows service name to query.',
        },
      },
      required: ['service_name'],
    },
  },
  {
    name: 'get_agent_config',
    description: 'Get the current Owlette agent configuration (sensitive fields like tokens are stripped).',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_agent_logs',
    description: 'Get recent Owlette agent log entries. Can filter by log level (ERROR, WARNING, INFO, DEBUG).',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        max_lines: {
          type: 'number',
          description: 'Maximum number of log lines to return (default: 100, max: 500).',
          default: 100,
        },
        level: {
          type: 'string',
          description: 'Filter by log level.',
          enum: ['ERROR', 'WARNING', 'INFO', 'DEBUG'],
        },
      },
    },
  },
  {
    name: 'get_agent_health',
    description: 'Get agent health status including connection state and health probe results.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── Tier 2: Process Management ─────────────────────────────────────────────

const tier2Tools: McpToolDefinition[] = [
  {
    name: 'restart_process',
    description: 'Restart an Owlette-configured process by name.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to restart (must be configured in Owlette).',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'kill_process',
    description: 'Kill/stop an Owlette-configured process by name.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to kill.',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'start_process',
    description: 'Start an Owlette-configured process by name.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to start.',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'set_launch_mode',
    description: 'Set the launch mode for an Owlette-configured process. Modes: "off" (not managed), "always" (24/7 with crash recovery), "scheduled" (runs during configured time windows only). When setting to "scheduled", also provide a schedules array with day/time blocks.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to set launch mode for.',
        },
        mode: {
          type: 'string',
          enum: ['off', 'always', 'scheduled'],
          description: 'The launch mode: "off", "always", or "scheduled".',
        },
        schedules: {
          type: 'array',
          description: 'Schedule blocks (required when mode is "scheduled"). Each block has days and time ranges.',
          items: {
            type: 'object',
            properties: {
              days: {
                type: 'array',
                items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
                description: 'Days this block applies to.',
              },
              ranges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    start: { type: 'string', description: 'Start time in HH:MM format.' },
                    stop: { type: 'string', description: 'Stop time in HH:MM format.' },
                  },
                  required: ['start', 'stop'],
                },
                description: 'Time windows within those days.',
              },
            },
            required: ['days', 'ranges'],
          },
        },
      },
      required: ['process_name', 'mode'],
    },
  },
  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of the remote machine\'s desktop. Returns a URL to the captured image in Firebase Storage. Use monitor=0 for all displays combined, or monitor=1, 2, etc. for a specific display.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        monitor: {
          type: 'number',
          description: 'Monitor index: 0 = all monitors combined (default), 1 = primary display, 2 = second display, etc.',
          default: 0,
        },
      },
    },
  },
];

// ─── Tier 3: Privileged Tools ───────────────────────────────────────────────

const tier3Tools: McpToolDefinition[] = [
  {
    name: 'run_command',
    description: 'Execute a shell command on the remote machine. The command must start with an allowed command (e.g., ipconfig, systeminfo, tasklist, nvidia-smi). Use nvidia-smi for advanced GPU diagnostics: Mosaic topology, detailed driver info, process-level VRAM usage, ECC status. Returns stdout, stderr, and exit code. Set user_session=true to run in the logged-in user\'s desktop session (needed for GUI/display access).',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        user_session: {
          type: 'boolean',
          description: 'If true, run in the interactive user session instead of the service session. Required for commands that need desktop/display access.',
          default: false,
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_powershell',
    description: 'Execute a PowerShell command on the remote machine. The first cmdlet must be in the allow-list (e.g., Get-Process, Get-Service). Returns stdout, stderr, and exit code. Set user_session=true to run in the logged-in user\'s desktop session.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The PowerShell command or script to execute.',
        },
        user_session: {
          type: 'boolean',
          description: 'If true, run in the interactive user session instead of the service session. Required for commands that need desktop/display access.',
          default: false,
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'run_python',
    description: 'Execute Python code on the remote machine in the user\'s desktop session. The code runs in the agent\'s Python environment with access to installed packages (mss, psutil, etc.). Use `output_dir` variable to write output files. Use `print()` for text output.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute. Has access to output_dir for writing files and print() for text output.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file on the remote machine (max 100KB).',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute file path to read.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file on the remote machine. Creates the file if it does not exist.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute file path to write to.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory on the remote machine with file sizes and modification dates.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute directory path to list.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'reboot_machine',
    description: 'Reboot the remote machine. Schedules a reboot with a 30-second delay so running processes can be saved. Can be cancelled within the countdown window.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'shutdown_machine',
    description: 'Shut down the remote machine. Schedules a shutdown with a 30-second delay. The machine will NOT automatically restart.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cancel_reboot',
    description: 'Cancel a pending reboot or shutdown on the remote machine. Must be called within the 30-second countdown window.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── Exports ────────────────────────────────────────────────────────────────

export const allTools: McpToolDefinition[] = [
  ...tier1Tools,
  ...tier2Tools,
  ...tier3Tools,
];

export function getToolsByTier(maxTier: ToolTier): McpToolDefinition[] {
  return allTools.filter((t) => t.tier <= maxTier);
}

export function getToolByName(name: string): McpToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

/**
 * Convert our tool definitions to the format expected by the Vercel AI SDK.
 * The AI SDK uses a slightly different schema format.
 */
export function toAISDKTools(tools: McpToolDefinition[]) {
  const result: Record<string, { description: string; parameters: unknown }> = {};
  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      parameters: tool.parameters,
    };
  }
  return result;
}

/**
 * Check if a tool requires user confirmation before execution.
 */
export function requiresConfirmation(toolName: string): boolean {
  const tool = getToolByName(toolName);
  return tool ? tool.tier >= 3 : true; // Unknown tools require confirmation
}

/**
 * Tier 2 tools that map to existing Owlette command types.
 * These are handled directly by the existing command system, not mcp_tools.py.
 */
export const EXISTING_COMMAND_MAPPINGS: Record<string, string> = {
  restart_process: 'restart_process',
  kill_process: 'kill_process',
  start_process: 'restart_process', // Start uses restart logic
  set_launch_mode: 'set_launch_mode',
  reboot_machine: 'reboot_machine',
  shutdown_machine: 'shutdown_machine',
  cancel_reboot: 'cancel_reboot',
  capture_screenshot: 'capture_screenshot',
};
