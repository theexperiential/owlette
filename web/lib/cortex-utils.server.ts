/**
 * Shared utilities for Cortex endpoints (user chat + autonomous).
 *
 * Extracted from /api/cortex/route.ts to be reused by /api/cortex/autonomous/route.ts.
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */

import { tool, jsonSchema } from 'ai';
import { decryptApiKey } from '@/lib/llm-encryption.server';
import {
  EXISTING_COMMAND_MAPPINGS,
  type McpToolDefinition,
} from '@/lib/mcp-tools';
import type { LlmConfig } from '@/lib/llm';

/** Tools that are executed server-side (query Firestore directly, not relayed to agent). */
const SERVER_SIDE_TOOLS = new Set(['get_site_logs']);

export const COMMAND_POLL_INTERVAL_MS = 1500;
export const COMMAND_TIMEOUT_MS = 30000;

export interface ResolveLlmConfigOptions {
  /** If true, skip user-level key and only read site-level config. */
  autonomous?: boolean;
}

/**
 * Resolve LLM config: user key first, then site key fallback.
 * In autonomous mode, only reads the site-level key.
 */
export async function resolveLlmConfig(
  db: FirebaseFirestore.Firestore,
  userId: string | null,
  siteId: string,
  options?: ResolveLlmConfigOptions
): Promise<LlmConfig> {
  // In user mode, check user-level key first
  if (!options?.autonomous && userId) {
    const userDoc = await db
      .collection('users')
      .doc(userId)
      .collection('settings')
      .doc('llm')
      .get();

    if (userDoc.exists) {
      const data = userDoc.data()!;
      try {
        return {
          provider: data.provider,
          apiKey: decryptApiKey(data.apiKeyEncrypted),
          model: data.model || undefined,
        };
      } catch {
        throw new Error(
          'Failed to decrypt your LLM API key. This usually means the server encryption key has changed since the key was saved. Please re-enter your API key in Account Settings → Cortex.'
        );
      }
    }
  }

  // Site-level key (fallback for user mode, primary for autonomous)
  const siteDoc = await db
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc('llm')
    .get();

  if (siteDoc.exists) {
    const data = siteDoc.data()!;
    let decryptedKey: string;
    try {
      decryptedKey = decryptApiKey(data.apiKeyEncrypted);
    } catch {
      throw new Error(
        options?.autonomous
          ? 'Failed to decrypt site-level LLM API key. The server encryption key may have changed — re-save the key in Admin Settings.'
          : 'Failed to decrypt the site LLM API key. The server encryption key may have changed. Please ask your admin to re-save the key, or set your own in Account Settings → Cortex.'
      );
    }
    const config: LlmConfig = {
      provider: data.provider,
      apiKey: decryptedKey,
      model: data.model || undefined,
    };

    // In autonomous mode, check for model override
    if (options?.autonomous && data.autonomousModel) {
      config.model = data.autonomousModel;
    }

    return config;
  }

  throw new Error(
    options?.autonomous
      ? 'No site-level LLM API key configured. Autonomous Cortex requires a site-level key.'
      : 'No LLM API key configured. Add one in Account Settings or ask your admin to set a site-level key.'
  );
}

/**
 * Verify user has access to the target site.
 */
export async function verifyUserSiteAccess(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string
): Promise<void> {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new Error('User not found');
  }
  const userData = userDoc.data()!;

  // Admins can access all sites
  if (userData.role === 'admin') return;

  const userSites: string[] = userData.sites || [];
  if (!userSites.includes(siteId)) {
    throw new Error('You do not have access to this site');
  }
}

/**
 * Check if a machine is online by reading its presence document.
 */
export async function isMachineOnline(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string
): Promise<boolean> {
  const presenceDoc = await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();

  if (!presenceDoc.exists) return false;

  const data = presenceDoc.data()!;
  const online = data.online ?? data.presence?.online ?? false;
  return !!online;
}

/**
 * Get all online machines for a site.
 */
export async function getOnlineMachines(
  db: FirebaseFirestore.Firestore,
  siteId: string
): Promise<string[]> {
  const machinesSnapshot = await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .get();

  const onlineMachines: string[] = [];
  for (const doc of machinesSnapshot.docs) {
    const data = doc.data();
    const online = data.online ?? data.presence?.online ?? false;
    if (online) {
      onlineMachines.push(doc.id);
    }
  }
  return onlineMachines;
}

/**
 * Send an MCP tool call command to an agent via Firestore and wait for the result.
 */
export async function executeToolOnAgent(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  toolName: string,
  toolParams: Record<string, unknown>,
  chatId: string
): Promise<unknown> {
  const commandId = `mcp_${Date.now()}_${toolName}`;

  // Use tool-provided timeout if available, otherwise default
  const toolTimeout = typeof toolParams.timeout_seconds === 'number'
    ? toolParams.timeout_seconds * 1000
    : COMMAND_TIMEOUT_MS;
  // Add buffer for agent-side overhead (startup, serialization)
  const pollTimeoutMs = toolTimeout + 10000;

  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  await pendingRef.set(
    {
      [commandId]: {
        type: 'mcp_tool_call',
        tool_name: toolName,
        tool_params: toolParams,
        chat_id: chatId,
        timestamp: Date.now(),
        status: 'pending',
        timeout_seconds: toolTimeout / 1000,
      },
    },
    { merge: true }
  );

  const completedRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');

  const startTime = Date.now();

  while (Date.now() - startTime < pollTimeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

    const completedDoc = await completedRef.get();
    if (!completedDoc.exists) continue;

    const data = completedDoc.data();
    const cmdResult = data?.[commandId];

    if (cmdResult) {
      const { FieldValue } = await import('firebase-admin/firestore');
      await completedRef.update({ [commandId]: FieldValue.delete() });

      if (cmdResult.status === 'failed') {
        return { error: cmdResult.error || 'Tool execution failed' };
      }

      const result = cmdResult.result;
      if (typeof result === 'string') {
        try {
          return JSON.parse(result);
        } catch {
          return { result };
        }
      }
      return result;
    }
  }

  // Timeout — clean up pending command
  try {
    const { FieldValue } = await import('firebase-admin/firestore');
    await pendingRef.update({ [commandId]: FieldValue.delete() });
  } catch {
    // Best effort cleanup
  }

  return { error: `Tool '${toolName}' timed out after ${Math.round(pollTimeoutMs / 1000)} seconds. The machine may be slow to respond or offline.` };
}

/**
 * Send an existing command type (Tier 2) to the agent.
 */
export async function executeExistingCommand(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  commandType: string,
  processName: string
): Promise<unknown> {
  const commandId = `${commandType}_${Date.now()}`;

  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  await pendingRef.set(
    {
      [commandId]: {
        type: commandType,
        process_name: processName,
        timestamp: Date.now(),
        status: 'pending',
      },
    },
    { merge: true }
  );

  const completedRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');

  const startTime = Date.now();

  while (Date.now() - startTime < COMMAND_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

    const completedDoc = await completedRef.get();
    const cmdResult = completedDoc.data()?.[commandId];

    if (cmdResult) {
      const { FieldValue } = await import('firebase-admin/firestore');
      await completedRef.update({ [commandId]: FieldValue.delete() });

      return {
        status: cmdResult.status,
        result: cmdResult.result || cmdResult.error || 'Command completed',
      };
    }
  }

  return { error: `Command '${commandType}' timed out` };
}

/**
 * Execute the get_site_logs tool server-side by querying Firestore directly.
 */
/**
 * Execute the get_site_logs tool server-side by querying Firestore directly.
 *
 * Fetches more than needed and filters in-memory for level/action to avoid
 * requiring composite indexes for every filter combination.
 */
async function executeSiteLogs(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const level = params.level as string | undefined;
  const hours = typeof params.hours === 'number' ? params.hours : 24;
  const limit = typeof params.limit === 'number' ? Math.min(params.limit, 200) : 50;
  const action = params.action as string | undefined;

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Only filter by timestamp in Firestore (avoids composite index requirements).
  // Apply level/action filters in-memory.
  const fetchLimit = (level || action) ? limit * 4 : limit;

  const logsQuery = db
    .collection('sites')
    .doc(siteId)
    .collection('logs')
    .where('timestamp', '>=', cutoff)
    .orderBy('timestamp', 'desc')
    .limit(Math.min(fetchLimit, 500));

  const snapshot = await logsQuery.get();

  let logs = snapshot.docs.map((doc) => {
    const data = doc.data();
    const ts = data.timestamp?.toDate
      ? data.timestamp.toDate().toISOString()
      : data.timestamp;
    return {
      timestamp: ts,
      machine: data.machineId || data.machine || 'unknown',
      action: data.action || '',
      level: data.level || 'info',
      process: data.processName || data.process || '',
      details: data.details || '',
    };
  });

  if (level) {
    logs = logs.filter((l) => l.level === level);
  }
  if (action) {
    logs = logs.filter((l) => l.action === action);
  }

  logs = logs.slice(0, limit);

  return { logs, count: logs.length, hours, siteId };
}

/**
 * Execute a server-side tool (not relayed to agent).
 */
async function executeServerSideTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'get_site_logs':
      return executeSiteLogs(db, siteId, params);
    default:
      return { error: `Unknown server-side tool: ${toolName}` };
  }
}

/**
 * Build AI SDK tools with execute functions that relay to agents.
 * In site mode, tool calls fan out to all online machines and aggregate results.
 */
export function buildExecutableTools(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  chatId: string,
  toolDefs: McpToolDefinition[],
  siteMode: boolean = false,
  onlineMachines: string[] = []
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of toolDefs) {
    const toolName = def.name;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolConfig: any = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      execute: async (params: unknown) => {
        // Server-side tools run directly on the web server (no agent relay)
        if (SERVER_SIDE_TOOLS.has(toolName)) {
          return executeServerSideTool(db, siteId, toolName, params as Record<string, unknown>);
        }

        if (siteMode) {
          const results = await Promise.all(
            onlineMachines.map(async (mid) => {
              try {
                const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
                if (existingCmd) {
                  const processName = (params as Record<string, unknown>).process_name as string;
                  const result = await executeExistingCommand(db, siteId, mid, existingCmd, processName);
                  return { machine: mid, ...result as Record<string, unknown> };
                }
                const result = await executeToolOnAgent(db, siteId, mid, toolName, params as Record<string, unknown>, chatId);
                return { machine: mid, ...(typeof result === 'object' && result !== null ? result as Record<string, unknown> : { result }) };
              } catch (err) {
                return { machine: mid, error: err instanceof Error ? err.message : 'Unknown error' };
              }
            })
          );
          return { machines: results };
        }

        // Single machine mode
        const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
        if (existingCmd) {
          const processName = (params as Record<string, unknown>).process_name as string;
          return executeExistingCommand(db, siteId, machineId, existingCmd, processName);
        }

        return executeToolOnAgent(db, siteId, machineId, toolName, params as Record<string, unknown>, chatId);
      },
    };

    // For capture_screenshot: inject the image as a vision content block
    // so the LLM can see and analyze the screenshot, not just get a URL string
    if (toolName === 'capture_screenshot') {
      toolConfig.toModelOutput = ({ output }: { output: unknown }) => {
        const result = output as Record<string, unknown> | null;
        const url = result?.url as string | undefined;
        const message = (result?.message as string) || (result?.error as string) || 'Screenshot captured';

        if (url) {
          return {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: message },
              { type: 'image-url' as const, url },
            ],
          };
        }
        // No URL (error case) — return text only
        return { type: 'text' as const, value: message };
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools[toolName] = tool<any, any>(toolConfig);
  }

  return tools;
}
