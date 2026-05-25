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
  type ToolTier,
} from '@/lib/mcp-tools';
import type { LlmConfig } from '@/lib/llm';
import { createProcess, ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';
import { updateProcess } from '@/lib/actions/updateProcess.server';
import { deleteProcess } from '@/lib/actions/deleteProcess.server';
import { ProcessConfigError, type PublicProcessConfig } from '@/lib/processConfig.server';
import type { Actor, Role } from '@/lib/capabilities';

/** Tools that are executed server-side (query Firestore directly, not relayed to agent). */
const SERVER_SIDE_TOOLS = new Set([
  'get_site_logs',
  'get_system_presets',
  'deploy_software',
  'update_process',
  'add_process',
  'delete_process',
]);

export const COMMAND_POLL_INTERVAL_MS = 1500;
export const COMMAND_TIMEOUT_MS = 30000;

const RESERVED_EXISTING_COMMAND_KEYS: ReadonlySet<string> = new Set<string>([
  'type',
  'process_name',
  'timestamp',
  'status',
]);

function stripReservedExistingCommandKeys(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_EXISTING_COMMAND_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface BuildExecutableToolsOptions {
  userId?: string;
  userRole?: string | null;
}

type ProcessToolResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeActorRole(role: string | null | undefined): Role {
  return role === 'member' || role === 'admin' || role === 'superadmin' ? role : 'member';
}

function actionContextForCortex(
  siteId: string,
  options: BuildExecutableToolsOptions,
): ActionContext {
  const userId = options.userId || 'unknown';
  const actor: Actor = {
    type: 'user',
    userId,
    role: normalizeActorRole(options.userRole),
    sites: [siteId],
  };
  return {
    siteId,
    actor,
    auditActor: `cortex:user_${userId}`,
  };
}

function actionErrorResult(error: unknown): ProcessToolResult {
  if (error instanceof ActionInputError) {
    return {
      ok: false,
      error: error.code,
      detail: error.message,
      status: error.status,
    };
  }
  if (error instanceof ProcessConfigError) {
    return {
      ok: false,
      error: error.code || 'process_config_error',
      detail: error.message,
      status: error.status,
    };
  }
  return {
    ok: false,
    error: 'internal_error',
    detail: error instanceof Error ? error.message : 'Unknown error',
  };
}

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
          'Failed to decrypt your LLM API key. This usually means the server encryption key has changed since the key was saved. Please re-enter your API key in Account Settings → cortex.'
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
          : 'Failed to decrypt the site LLM API key. The server encryption key may have changed. Please ask your admin to re-save the key, or set your own in Account Settings → cortex.'
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
      ? 'No site-level LLM API key configured. Autonomous cortex requires a site-level key.'
      : 'No LLM API key configured. Add one in Account Settings or ask your admin to set a site-level key.'
  );
}

/**
 * Resolved access level for a user against a site. Used to choose which
 * Cortex tool tier the caller is allowed to drive.
 *
 * `isSiteAdmin` mirrors the canonical client-side `isSiteAdmin(siteId)` in
 * AuthContext — superadmin, or `admin` role with ownership/assignment.
 */
export interface SiteAccessLevel {
  role: string | null;
  isSuperadmin: boolean;
  isSiteAdmin: boolean;
  isSiteOwner: boolean;
}

/**
 * Verify user has access to the target site, and return their access level.
 *
 * Access is granted iff the user is superadmin, the site owner, or listed in
 * `users/{uid}.sites[]`. Matches `assertUserHasSiteAccess` in apiAuth.server.
 * Site owners are explicitly honored so a freshly-created site's owner is not
 * locked out before the user's `sites[]` array has been updated.
 *
 * Throws on no-access. Callers use the returned access level to decide what
 * the user is allowed to do once past the gate (e.g. which tool tier to grant).
 */
export async function verifyUserSiteAccess(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string
): Promise<SiteAccessLevel> {
  const [userDoc, siteDoc] = await Promise.all([
    db.collection('users').doc(userId).get(),
    db.collection('sites').doc(siteId).get(),
  ]);

  if (!userDoc.exists) {
    throw new Error('User not found');
  }
  if (!siteDoc.exists) {
    throw new Error('Site not found');
  }

  const userData = userDoc.data()!;
  const siteData = siteDoc.data() || {};
  const role: string | null = typeof userData.role === 'string' ? userData.role : null;
  const isSuperadmin = role === 'superadmin';
  const isSiteOwner = siteData.owner === userId;
  const userSites: string[] = Array.isArray(userData.sites) ? userData.sites : [];
  const isAssigned = userSites.includes(siteId);

  if (!isSuperadmin && !isSiteOwner && !isAssigned) {
    throw new Error('You do not have access to this site');
  }

  // Mirrors AuthContext.isSiteAdmin: superadmin, or admin role with
  // ownership/assignment. Members never get admin privileges.
  const isSiteAdmin = isSuperadmin || (role === 'admin' && (isSiteOwner || isAssigned));

  return { role, isSuperadmin, isSiteAdmin, isSiteOwner };
}

/**
 * Resolve the maximum Cortex tool tier a caller is allowed to drive based on
 * their site access level.
 *
 * - Site admins (superadmin, or `admin` with site access) → tier 3 (full).
 * - Everyone else with site access → tier 1 (read-only). Members must not be
 *   able to trigger tier 2 (registry writes, feature installs, disk cleans)
 *   or tier 3 (run_powershell, execute_script, deploy_software, reboot, etc.).
 */
export function resolveCortexMaxTier(access: SiteAccessLevel): ToolTier {
  return access.isSiteAdmin ? 3 : 1;
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
  const online = data.online ?? false;
  return !!online;
}

/**
 * Check whether Cortex tool-call delivery is enabled for a machine.
 * Defaults to true when the field is absent (backwards-compatible).
 */
export async function isCortexEnabled(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string
): Promise<boolean> {
  const machineDoc = await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();

  if (!machineDoc.exists) return true;

  return machineDoc.data()?.cortexEnabled !== false;
}

/**
 * Whether tier-3 (privileged) Cortex tool calls require explicit in-chat
 * approval before they execute, for the given site.
 *
 * Stored at `sites/{siteId}/settings/cortex.requireTier3Approval`. Defaults to
 * `true` when the doc or field is absent so the safety gate is on by default —
 * an admin must deliberately opt out per site.
 *
 * When this is `true`, single-machine admin chats are forced through the
 * server-side LLM path (skipping local Cortex) so the AI SDK's `needsApproval`
 * gate can fire — see the routing decision in `runCortexStream` /
 * `app/api/cortex/route.ts`. When `false`, local Cortex is allowed and the
 * gate does not apply (the agent runs tools locally; approval is not enforced).
 */
export async function getCortexRequireTier3Approval(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<boolean> {
  try {
    const settingsDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('settings')
      .doc('cortex')
      .get();

    if (!settingsDoc.exists) return true;

    return settingsDoc.data()?.requireTier3Approval !== false;
  } catch {
    // Fail safe: if we can't read the setting, keep the gate on.
    return true;
  }
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
    const online = data.online ?? false;
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
  processName: string,
  extraParams: Record<string, unknown> = {}
): Promise<unknown> {
  const commandId = `${commandType}_${Date.now()}`;
  const safeExtraParams = stripReservedExistingCommandKeys(extraParams);

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
        ...safeExtraParams,
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
  let silentFlags = (params.silent_flags as string) || preset?.silent_flags || '';
  const verifyPath = (params.verify_path as string) || preset?.verify_path || '';
  const closeProcesses = (params.close_processes as string[]) || preset?.close_processes || [];
  const timeoutSeconds = timeoutMinutes * 60;

  // ── TouchDesigner version-aware overrides ───────────────────────────────
  const isTD = softwareName.toLowerCase().includes('touchdesigner');
  // Auto-enable parallel install for TouchDesigner; explicit param overrides
  const parallelInstall = params.parallel_install !== undefined
    ? Boolean(params.parallel_install)
    : (isTD || Boolean(preset?.parallel_install));
  if (version && isTD) {
    // Auto-resolve URL if not explicitly provided
    if (!params.installer_url) {
      installerUrl = `https://download.derivative.ca/TouchDesigner.${version}.exe`;
      installerName = `TouchDesigner.${version}.exe`;
    }

    // CRITICAL: Replace /DIR in silent flags to match the target version.
    // Presets may have an old version path hardcoded — never install to wrong dir.
    if (!params.silent_flags) {
      const correctDir = `C:\\Program Files\\Derivative\\TouchDesigner.${version}`;
      silentFlags = silentFlags.replace(
        /\/DIR="[^"]*"/i,
        `/DIR="${correctDir}"`
      );
      // If no /DIR was present, add it
      if (!/\/DIR=/i.test(silentFlags)) {
        silentFlags = `${silentFlags} /DIR="${correctDir}"`;
      }
    }
  }

  // ── Resolve verify_path ─────────────────────────────────────────────────
  let resolvedVerifyPath = verifyPath;
  if (version && isTD && !params.verify_path) {
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
  if (parallelInstall) {
    deploymentData.parallel_install = true;
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
    if (parallelInstall) {
      commandData.parallel_install = true;
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
    message: `Deployment started: ${version ? `${softwareName} ${version}` : softwareName} is being downloaded and installed on ${machineIds.length} machine${machineIds.length > 1 ? 's' : ''}. Track progress on the [Deployments page](/deployments).`,
  };
}

async function resolveProcessIdByName(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; processId: string; processName: string } | { ok: false; result: ProcessToolResult }> {
  const processName = params.process_name;
  if (typeof processName !== 'string' || processName.trim().length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'missing_process_name',
        detail: 'process_name is required.',
        status: 400,
      },
    };
  }

  let configDoc: FirebaseFirestore.DocumentSnapshot;
  try {
    configDoc = await db
      .collection('config')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'config_lookup_failed',
        detail: error instanceof Error ? error.message : 'Failed to read process configuration.',
        status: 500,
      },
    };
  }

  if (!configDoc.exists) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'config_not_found',
        detail: `Configuration not found for machine ${machineId}.`,
        status: 404,
      },
    };
  }

  const processes = configDoc.data()?.processes;
  if (!Array.isArray(processes)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'invalid_config',
        detail: `Configuration for machine ${machineId} does not contain a valid processes array.`,
        status: 500,
      },
    };
  }

  const process = processes.find((candidate: unknown) =>
    isRecord(candidate) && candidate.name === processName
  );
  if (!isRecord(process)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'process_not_found',
        detail: `Process "${processName}" was not found on machine ${machineId}.`,
        status: 404,
      },
    };
  }

  const processId =
    typeof process.processId === 'string'
      ? process.processId
      : typeof process.id === 'string'
        ? process.id
        : '';
  if (!processId) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'process_id_missing',
        detail: `Process "${processName}" does not have a processId or legacy id.`,
        status: 500,
      },
    };
  }

  return { ok: true, processId, processName };
}

function patchFromProcessParams(params: Record<string, unknown>): Partial<PublicProcessConfig> {
  const patch: Record<string, unknown> = { ...params };
  delete patch.process_name;
  return patch as Partial<PublicProcessConfig>;
}

async function executeProcessToolForMachines(
  machineIds: string[],
  handler: (machineId: string) => Promise<ProcessToolResult>,
): Promise<unknown> {
  if (machineIds.length === 0) {
    return {
      ok: false,
      error: 'no_target_machines',
      detail: 'No target machines available.',
      status: 404,
    };
  }

  if (machineIds.length === 1) {
    return handler(machineIds[0]);
  }

  const machines = await Promise.all(
    machineIds.map(async (machineId) => ({
      machine: machineId,
      ...(await handler(machineId)),
    })),
  );
  return { machines };
}

async function executeUpdateProcessTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  return executeProcessToolForMachines(machineIds, async (machineId) => {
    const lookup = await resolveProcessIdByName(db, siteId, machineId, params);
    if (!lookup.ok) return lookup.result;

    try {
      const result = await updateProcess(
        actionContextForCortex(siteId, options),
        {
          machineId,
          processId: lookup.processId,
          patch: patchFromProcessParams(params),
        },
      );
      return {
        ok: true,
        processId: result.processId,
        process_name: lookup.processName,
      };
    } catch (error) {
      return actionErrorResult(error);
    }
  });
}

async function executeAddProcessTool(
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  return executeProcessToolForMachines(machineIds, async (machineId) => {
    try {
      const result = await createProcess(
        actionContextForCortex(siteId, options),
        {
          machineId,
          ...params,
        } as Parameters<typeof createProcess>[1],
      );
      return {
        ok: true,
        processId: result.processId,
        name: params.name ?? null,
      };
    } catch (error) {
      return actionErrorResult(error);
    }
  });
}

async function executeDeleteProcessTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  return executeProcessToolForMachines(machineIds, async (machineId) => {
    const lookup = await resolveProcessIdByName(db, siteId, machineId, params);
    if (!lookup.ok) return lookup.result;

    try {
      const result = await deleteProcess(
        actionContextForCortex(siteId, options),
        {
          machineId,
          processId: lookup.processId,
        },
      );
      return {
        ok: true,
        processId: result.processId,
        process_name: lookup.processName,
        alreadyDeleted: result.alreadyDeleted,
      };
    } catch (error) {
      return actionErrorResult(error);
    }
  });
}

/**
 * Execute a server-side tool (not relayed to agent).
 */
async function executeServerSideTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  toolName: string,
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  switch (toolName) {
    case 'get_site_logs':
      return executeSiteLogs(db, siteId, params);
    case 'get_system_presets':
      return executeGetSystemPresets(db, params);
    case 'deploy_software':
      return executeDeploySoftware(db, siteId, machineIds, params);
    case 'update_process':
      return executeUpdateProcessTool(db, siteId, machineIds, params, options);
    case 'add_process':
      return executeAddProcessTool(siteId, machineIds, params, options);
    case 'delete_process':
      return executeDeleteProcessTool(db, siteId, machineIds, params, options);
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
  onlineMachines: string[] = [],
  options: BuildExecutableToolsOptions = {},
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of toolDefs) {
    const toolName = def.name;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolConfig: any = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      // Tier-3 tools (run_powershell, execute_script, reboot_machine, etc.)
      // pause for explicit in-chat approval before `execute` runs. The AI SDK
      // emits a `tool-approval-request` part instead of calling `execute`; the
      // client surfaces approve/deny and resumes the stream once answered.
      // Tier 1/2 keep auto-running. This is a chat-only guardrail — autonomous
      // Cortex uses a separate `buildAutonomousTools` (no human to approve), so
      // it is intentionally unaffected.
      needsApproval: def.tier >= 3,
      execute: async (params: unknown) => {
        // Server-side tools run directly on the web server (no agent relay)
        if (SERVER_SIDE_TOOLS.has(toolName)) {
          // For deploy_software in site mode, target all online machines
          const targetMachineIds = siteMode ? onlineMachines : [machineId];
          return executeServerSideTool(
            db,
            siteId,
            targetMachineIds,
            toolName,
            params as Record<string, unknown>,
            options,
          );
        }

        if (siteMode) {
          const results = await Promise.all(
            onlineMachines.map(async (mid) => {
              try {
                const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
                if (existingCmd) {
                  const toolParams = params as Record<string, unknown>;
                  const processName = toolParams.process_name as string;
                  const result = await executeExistingCommand(db, siteId, mid, existingCmd, processName, toolParams);
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
          const toolParams = params as Record<string, unknown>;
          const processName = toolParams.process_name as string;
          return executeExistingCommand(db, siteId, machineId, existingCmd, processName, toolParams);
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
