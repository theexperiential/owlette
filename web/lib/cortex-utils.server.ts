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
      return {
        provider: data.provider,
        apiKey: decryptApiKey(data.apiKeyEncrypted),
        model: data.model || undefined,
      };
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
    const config: LlmConfig = {
      provider: data.provider,
      apiKey: decryptApiKey(data.apiKeyEncrypted),
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
        timeout_seconds: COMMAND_TIMEOUT_MS / 1000,
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

  return { error: `Tool '${toolName}' timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds. The machine may be slow to respond or offline.` };
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
    tools[toolName] = tool<any, any>({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      execute: async (params) => {
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
    });
  }

  return tools;
}
