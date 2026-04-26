/**
 * createDeployment action core (security-boundary-migration wave 3.3).
 *
 * Lifted from the api-sprint wave-1 body of
 * `web/app/api/sites/[siteId]/deployments/route.ts` so cortex (`invokeAsSystem`)
 * and the route shim share the same single source of truth. Public contract
 * is preserved bit-for-bit — the route shim continues to surface every
 * existing field exactly as before.
 *
 * Behavior:
 *   1. validate body (fail-fast with discriminated `{ ok: false, code }`)
 *   2. read `sites/{siteId}.deployQuota` (default 100), reject 413 if over
 *   3. write the deployment doc with `status: 'pending'` + targets[]
 *   4. fan out `install_software` commands via the wave-2.2 helper
 *   5. flip parent doc to `status: 'in_progress'`
 *   6. emit `deployment_mutated` audit event
 *
 * Wave 4.3 will delete the listener-driven `transaction.set` writes from
 * `useDeployments.ts` — the cloud function `reconcileDeploymentStatus` (wave
 * 2.4) is now the authoritative source of status reconciliation. We do NOT
 * replicate that logic here.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { fanOutToMachines } from '@/lib/fanOut.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

/** default per-site target quota when `sites/{siteId}.deployQuota` is unset. */
export const DEFAULT_DEPLOYMENT_MAX_TARGETS = 100;

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

export interface CreateDeploymentInput {
  /** human-readable label. */
  name: string;
  /** filename of the installer binary. */
  installer_name: string;
  /** signed download url — must be `https://`. */
  installer_url: string;
  /** silent-install command-line flags (e.g. `/SILENT /NORESTART`). */
  silent_flags: string;
  /** optional post-install verification path on disk. */
  verify_path?: string;
  /** optional 64-char hex sha-256 of the installer binary. */
  sha256_checksum?: string;
  /** if true, agents may run the installer alongside other tasks. */
  parallel_install?: boolean;
  /** target machine ids in this site. duplicates are de-duplicated. */
  machines: string[];
}

export interface CreateDeploymentContext {
  siteId: string;
  /** Firebase uid of the calling user. Preserves the legacy deployment doc shape. */
  createdBy: string;
  /** `user:<uid>` or `apiKey:<keyId>` for audit-log mutation events. */
  actorIdentifier: string;
  /** opaque correlation id woven through audit + commands. */
  correlationId: string;
  /**
   * Optional Firestore override for unit tests. Production callers omit
   * and `getAdminDb()` is used.
   */
  db?: ReturnType<typeof getAdminDb>;
  /** Override `Date.now()` — unit tests pass a fixed clock. */
  now?: () => number;
}

export type CreateDeploymentResult =
  | {
      ok: true;
      deploymentId: string;
      siteId: string;
      status: 'in_progress';
      targets: Array<{ machineId: string; status: 'pending' }>;
    }
  | {
      ok: false;
      code:
        | 'invalid_name'
        | 'invalid_installer_name'
        | 'invalid_installer_url'
        | 'installer_url_not_https'
        | 'invalid_silent_flags'
        | 'invalid_verify_path'
        | 'invalid_sha256_checksum'
        | 'invalid_machines'
        | 'over_quota';
      message: string;
      details?: Record<string, unknown>;
    };

interface ValidatedInput {
  name: string;
  installerName: string;
  installerUrl: string;
  silentFlags: string;
  verifyPath?: string;
  sha256?: string;
  parallelInstall: boolean;
  machines: string[];
}

function validateInput(
  input: CreateDeploymentInput,
): ValidatedInput | { error: Extract<CreateDeploymentResult, { ok: false }> } {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_name',
        message: 'field `name` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.installer_name !== 'string' || input.installer_name.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_installer_name',
        message: 'field `installer_name` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.installer_url !== 'string' || input.installer_url.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_installer_url',
        message: 'field `installer_url` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.silent_flags !== 'string') {
    return {
      error: {
        ok: false,
        code: 'invalid_silent_flags',
        message: 'field `silent_flags` is required and must be a string',
      },
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.installer_url);
  } catch {
    return {
      error: {
        ok: false,
        code: 'invalid_installer_url',
        message: 'installer_url must be a valid URL',
      },
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      error: {
        ok: false,
        code: 'installer_url_not_https',
        message: 'installer_url must use HTTPS protocol',
      },
    };
  }

  let verifyPath: string | undefined;
  if (input.verify_path !== undefined && input.verify_path !== null) {
    if (typeof input.verify_path !== 'string') {
      return {
        error: {
          ok: false,
          code: 'invalid_verify_path',
          message: 'verify_path must be a string when provided',
        },
      };
    }
    verifyPath = input.verify_path;
  }

  let sha256: string | undefined;
  if (input.sha256_checksum !== undefined && input.sha256_checksum !== null) {
    if (typeof input.sha256_checksum !== 'string' || !SHA256_HEX_RE.test(input.sha256_checksum)) {
      return {
        error: {
          ok: false,
          code: 'invalid_sha256_checksum',
          message: 'sha256_checksum must be a 64-character hex SHA-256 hash',
        },
      };
    }
    sha256 = input.sha256_checksum;
  }

  const parallelInstall = input.parallel_install === true;

  if (
    !Array.isArray(input.machines) ||
    input.machines.some((m) => typeof m !== 'string' || m.length === 0)
  ) {
    return {
      error: {
        ok: false,
        code: 'invalid_machines',
        message: 'field `machines` must be a non-empty array of machineId strings',
      },
    };
  }
  const machines = [...new Set(input.machines)];
  if (machines.length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_machines',
        message: 'machines must not be empty',
      },
    };
  }

  return {
    name: input.name.trim(),
    installerName: input.installer_name.trim(),
    installerUrl: input.installer_url,
    silentFlags: input.silent_flags,
    verifyPath,
    sha256,
    parallelInstall,
    machines,
  };
}

/**
 * Create an installer deployment and fan-out `install_software` commands.
 *
 * Mirrors `createDistribution` for the deployments surface. The deployment
 * document and per-machine command payloads carry the legacy field names
 * the agent already reads (`installer_url`, `installer_name`, `silent_flags`,
 * `deployment_id`) so v3.0.0 agents accept the writes without modification.
 */
export async function createDeployment(
  input: CreateDeploymentInput,
  ctx: CreateDeploymentContext,
): Promise<CreateDeploymentResult> {
  const validated = validateInput(input);
  if ('error' in validated) return validated.error;

  const db = ctx.db ?? getAdminDb();
  const now = ctx.now ?? (() => Date.now());

  // Per-site quota check — read `sites/{siteId}.deployQuota`. Missing or
  // invalid → fall back to the default. Mirrors the distribution path.
  const siteSnap = await db.collection('sites').doc(ctx.siteId).get();
  const siteData = siteSnap.exists ? (siteSnap.data() ?? {}) : {};
  const quotaRaw = (siteData as Record<string, unknown>).deployQuota;
  const maxTargets =
    typeof quotaRaw === 'number' && Number.isFinite(quotaRaw) && quotaRaw > 0
      ? Math.floor(quotaRaw)
      : DEFAULT_DEPLOYMENT_MAX_TARGETS;

  if (validated.machines.length > maxTargets) {
    return {
      ok: false,
      code: 'over_quota',
      message: `requested ${validated.machines.length} target machines but max-targets-per-deploy on this site is ${maxTargets}`,
      details: { max_targets: maxTargets, requested: validated.machines.length },
    };
  }

  const deploymentId = `deploy-${now()}`;
  const deploymentRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('deployments')
    .doc(deploymentId);

  const targets = validated.machines.map((machineId) => ({
    machineId,
    status: 'pending' as const,
  }));

  const deploymentData: Record<string, unknown> = {
    name: validated.name,
    installer_name: validated.installerName,
    installer_url: validated.installerUrl,
    silent_flags: validated.silentFlags,
    targets,
    createdAt: FieldValue.serverTimestamp(),
    status: 'pending',
    createdBy: ctx.createdBy,
    auditCorrelationId: ctx.correlationId,
  };
  if (validated.sha256) deploymentData.sha256_checksum = validated.sha256;
  if (validated.verifyPath) deploymentData.verify_path = validated.verifyPath;
  if (validated.parallelInstall) deploymentData.parallel_install = true;

  await deploymentRef.set(deploymentData);

  // Fan out `install_software` commands via the wave-2.2 helper. The helper
  // chunks at FANOUT_CHUNK_SIZE (50) and threads `auditCorrelationId` into
  // each command's metadata. Underscore-prefixed ids match the legacy hook
  // shape so the agent's listener sees identical keys to today's writes.
  const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
  const commandIdPrefix = `install_${sanitizedDeploymentId}`;

  const fanOutResults = await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: validated.machines,
    correlationId: ctx.correlationId,
    db,
    now,
    builder: () => {
      const commandData: Record<string, unknown> = {
        type: 'install_software',
        installer_url: validated.installerUrl,
        installer_name: validated.installerName,
        silent_flags: validated.silentFlags,
        deployment_id: deploymentId,
        timestamp: FieldValue.serverTimestamp(),
        status: 'pending',
      };
      if (validated.sha256) commandData.sha256_checksum = validated.sha256;
      if (validated.verifyPath) commandData.verify_path = validated.verifyPath;
      if (validated.parallelInstall) commandData.parallel_install = true;
      return { commandIdPrefix, commandData };
    },
  });
  const failedFanOut = fanOutResults.find((result) => !result.ok);
  if (failedFanOut) {
    throw new Error(
      `failed to fan out install_software command to ${failedFanOut.machineId}: ${failedFanOut.error ?? 'unknown error'}`,
    );
  }

  await deploymentRef.update({ status: 'in_progress' });

  try {
    emitMutation({
      kind: 'deployment_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: deploymentId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/deployments`,
        method: 'POST',
        verb: 'create',
        target_count: validated.machines.length,
        installer_name: validated.installerName,
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    // emitMutation is fire-and-forget by design, but defensive logging here
    // catches any sync throw before the network handoff.
    logger.warn('[createDeployment] mutation emit threw synchronously', {
      context: 'createDeployment',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    deploymentId,
    siteId: ctx.siteId,
    status: 'in_progress',
    targets,
  };
}
