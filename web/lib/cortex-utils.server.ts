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
const SERVER_SIDE_TOOLS = new Set(['get_site_logs', 'get_system_presets', 'deploy_software']);

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
 * Execute the get_system_presets tool server-side by querying Firestore directly.
 */
async function executeGetSystemPresets(
  db: FirebaseFirestore.Firestore,
  params: Record<string, unknown>
): Promise<unknown> {
  const softwareNameFilter = params.software_name as string | undefined;
  const categoryFilter = params.category as string | undefined;

  const snapshot = await db.collection('system_presets').get();

  let presets = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || '',
        software_name: data.software_name || '',
        category: data.category || '',
        description: data.description || '',
        installer_name: data.installer_name || '',
        installer_url: data.installer_url || '',
        silent_flags: data.silent_flags || '',
        verify_path: data.verify_path || undefined,
        close_processes: data.close_processes || [],
        timeout_seconds: data.timeout_seconds || undefined,
      };
    })
    // Exclude Owlette self-update presets
    .filter((p) => !snapshot.docs.find((d) => d.id === p.id)?.data().is_owlette_agent);

  if (softwareNameFilter) {
    const filter = softwareNameFilter.toLowerCase();
    presets = presets.filter(
      (p) =>
        p.software_name.toLowerCase().includes(filter) ||
        p.name.toLowerCase().includes(filter)
    );
  }

  if (categoryFilter) {
    const filter = categoryFilter.toLowerCase();
    presets = presets.filter((p) => p.category.toLowerCase().includes(filter));
  }

  return { presets, count: presets.length };
}

/**
 * Execute the deploy_software tool server-side.
 *
 * Resolves preset + params, creates a deployment doc, and writes install_software
 * commands to the target machines. Returns immediately — installation runs async.
 */
async function executeDeploySoftware(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>
): Promise<unknown> {
  const softwareName = params.software_name as string;
  const version = params.version as string | undefined;
  const presetId = params.preset_id as string | undefined;
  const timeoutMinutes = typeof params.timeout_minutes === 'number' ? params.timeout_minutes : 40;

  if (!softwareName) {
    return { error: 'software_name is required' };
  }

  if (machineIds.length === 0) {
    return { error: 'No target machines available. The machine may be offline.' };
  }

  // ── Resolve preset ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let preset: Record<string, any> | null = null;

  if (presetId) {
    const presetDoc = await db.collection('system_presets').doc(presetId).get();
    if (presetDoc.exists) {
      preset = presetDoc.data()!;
    } else {
      return { error: `Preset '${presetId}' not found` };
    }
  } else {
    // Find best match by software_name
    const snapshot = await db.collection('system_presets').get();
    const filter = softwareName.toLowerCase();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.is_owlette_agent) continue;
      if (
        (data.software_name || '').toLowerCase().includes(filter) ||
        (data.name || '').toLowerCase().includes(filter)
      ) {
        preset = { id: doc.id, ...data };
        break;
      }
    }
  }

  // ── Merge preset with explicit overrides ────────────────────────────────
  let installerUrl = (params.installer_url as string) || preset?.installer_url || '';
  let installerName = (params.installer_name as string) || preset?.installer_name || '';
  const silentFlags = (params.silent_flags as string) || preset?.silent_flags || '';
  const verifyPath = (params.verify_path as string) || preset?.verify_path || '';
  const closeProcesses = (params.close_processes as string[]) || preset?.close_processes || [];
  const timeoutSeconds = timeoutMinutes * 60;

  // ── TouchDesigner URL auto-resolve ──────────────────────────────────────
  if (
    version &&
    softwareName.toLowerCase().includes('touchdesigner') &&
    !params.installer_url // Only auto-resolve if user didn't explicitly provide a URL
  ) {
    installerUrl = `https://download.derivative.ca/TouchDesigner.${version}.exe`;
    installerName = `TouchDesigner.${version}.exe`;
  }

  // ── Also update verify_path for TouchDesigner if version is provided ────
  let resolvedVerifyPath = verifyPath;
  if (
    version &&
    softwareName.toLowerCase().includes('touchdesigner') &&
    !params.verify_path
  ) {
    resolvedVerifyPath = `C:\\Program Files\\Derivative\\TouchDesigner.${version}`;
  }

  // ── Validate ────────────────────────────────────────────────────────────
  if (!installerUrl) {
    return {
      error: `No installer URL available for "${softwareName}". Provide an installer_url or ensure a matching system preset exists with the URL configured.`,
    };
  }
  if (!installerUrl.startsWith('https://')) {
    return { error: 'installer_url must use HTTPS for security' };
  }
  if (!installerName) {
    // Derive from URL as fallback
    installerName = installerUrl.split('/').pop() || 'installer.exe';
  }
  if (!silentFlags) {
    return {
      error: `No silent installation flags configured for "${softwareName}". Provide silent_flags or ensure the system preset has them configured.`,
    };
  }

  // ── Create deployment doc (mirrors useDeployments.createDeployment) ─────
  const deploymentId = `deploy-${Date.now()}`;
  const deploymentRef = db
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc(deploymentId);

  const targets = machineIds.map((mid) => ({
    machineId: mid,
    status: 'pending',
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deploymentData: Record<string, any> = {
    name: version ? `${softwareName} ${version}` : softwareName,
    installer_name: installerName,
    installer_url: installerUrl,
    silent_flags: silentFlags,
    targets,
    createdAt: Date.now(),
    status: 'pending',
    source: 'cortex',
  };

  if (resolvedVerifyPath) {
    deploymentData.verify_path = resolvedVerifyPath;
  }
  if (closeProcesses.length > 0) {
    deploymentData.close_processes = closeProcesses;
  }

  await deploymentRef.set(deploymentData);

  // ── Write install_software command to each machine ──────────────────────
  const commandPromises = machineIds.map(async (mid) => {
    const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
    const sanitizedMachineId = mid.replace(/-/g, '_');
    const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${Date.now()}`;

    const pendingRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(mid)
      .collection('commands')
      .doc('pending');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commandData: Record<string, any> = {
      type: 'install_software',
      installer_url: installerUrl,
      installer_name: installerName,
      silent_flags: silentFlags,
      deployment_id: deploymentId,
      timestamp: Date.now(),
      status: 'pending',
      timeout_seconds: timeoutSeconds,
    };

    if (resolvedVerifyPath) {
      commandData.verify_path = resolvedVerifyPath;
    }
    if (closeProcesses.length > 0) {
      commandData.close_processes = closeProcesses;
    }

    await pendingRef.set({ [commandId]: commandData }, { merge: true });
  });

  await Promise.all(commandPromises);

  // Update deployment status to in_progress
  await deploymentRef.set({ status: 'in_progress' }, { merge: true });

  return {
    status: 'deployment_started',
    deployment_id: deploymentId,
    software_name: softwareName,
    version: version || null,
    installer_url: installerUrl,
    target_machines: machineIds.length,
    message: `Deployment started: ${version ? `${softwareName} ${version}` : softwareName} is being downloaded and installed on ${machineIds.length} machine${machineIds.length > 1 ? 's' : ''}. Track progress on the Deployments page.`,
  };
}

/**
 * Execute a server-side tool (not relayed to agent).
 */
async function executeServerSideTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  toolName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'get_site_logs':
      return executeSiteLogs(db, siteId, params);
    case 'get_system_presets':
      return executeGetSystemPresets(db, params);
    case 'deploy_software':
      return executeDeploySoftware(db, siteId, machineIds, params);
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
          // For deploy_software in site mode, target all online machines
          const targetMachineIds = siteMode ? onlineMachines : [machineId];
          return executeServerSideTool(db, siteId, targetMachineIds, toolName, params as Record<string, unknown>);
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
