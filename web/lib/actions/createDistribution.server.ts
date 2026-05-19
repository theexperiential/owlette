/**
 * createDistribution action core (security-boundary-migration wave 3.4).
 *
 * Mirrors the deployment create pattern from
 * `web/app/api/sites/[siteId]/deployments/route.ts` (api-sprint wave 1):
 * write the parent doc at `sites/{siteId}/project_distributions/{distId}`
 * with a `targets[]` array, fan out `distribute_project` commands to every
 * target machine via the wave-2.2 fan-out helper, then flip the parent doc
 * to `status: 'in_progress'`.
 *
 * The action is the single source of truth for create-distribution business
 * logic. The route shim parses the body, runs auth + idempotency, then calls
 * this action; cortex / cron callers reach the same logic via `invokeAsSystem`
 * (wave 3.12).
 *
 * Validation is internal so the route shim doesn't have to repeat it. Returns
 * a discriminated `{ ok: true, ... } | { ok: false, ... }` so the caller can
 * surface RFC 7807 errors without converting throws.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { fanOutToMachines } from '@/lib/fanOut.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

/** default per-site target quota when `sites/{siteId}.distributionQuota` is unset. */
export const DEFAULT_DISTRIBUTION_MAX_TARGETS = 100;

export interface CreateDistributionInput {
  /** human-readable label (required by `firestore.rules`). */
  name: string;
  /** legacy field name expected by the rules + agent. */
  file_name: string;
  /** signed download url — must be `https://`. */
  project_url: string;
  /** optional override of the agent-side extract destination. */
  extract_path?: string;
  /** optional integrity-proof file paths the agent verifies post-extract. */
  verify_files?: string[];
  /** target machine ids in this site. duplicates are de-duplicated. */
  machines: string[];
}

export interface CreateDistributionContext {
  siteId: string;
  /** Firebase uid of the calling user, or `apiKey:<keyId>` when key-mediated. */
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

export type CreateDistributionResult =
  | {
      ok: true;
      distributionId: string;
      siteId: string;
      status: 'in_progress';
      targets: Array<{ machineId: string; status: 'pending' }>;
    }
  | {
      ok: false;
      code:
        | 'invalid_name'
        | 'invalid_file_name'
        | 'invalid_project_url'
        | 'project_url_not_https'
        | 'invalid_extract_path'
        | 'invalid_verify_files'
        | 'invalid_machines'
        | 'over_quota';
      message: string;
      details?: Record<string, unknown>;
    };

interface ValidatedInput {
  name: string;
  fileName: string;
  projectUrl: string;
  extractPath?: string;
  verifyFiles?: string[];
  machines: string[];
}

function validateInput(input: CreateDistributionInput): ValidatedInput | { error: Extract<CreateDistributionResult, { ok: false }> } {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_name',
        message: 'field `name` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.file_name !== 'string' || input.file_name.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_file_name',
        message: 'field `file_name` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.project_url !== 'string' || input.project_url.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_project_url',
        message: 'field `project_url` is required and must be a non-empty string',
      },
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.project_url);
  } catch {
    return {
      error: {
        ok: false,
        code: 'invalid_project_url',
        message: 'project_url must be a valid URL',
      },
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      error: {
        ok: false,
        code: 'project_url_not_https',
        message: 'project_url must use HTTPS protocol',
      },
    };
  }

  let extractPath: string | undefined;
  if (input.extract_path !== undefined && input.extract_path !== null) {
    if (typeof input.extract_path !== 'string') {
      return {
        error: {
          ok: false,
          code: 'invalid_extract_path',
          message: 'extract_path must be a string when provided',
        },
      };
    }
    if (input.extract_path.trim().length > 0) extractPath = input.extract_path;
  }

  let verifyFiles: string[] | undefined;
  if (input.verify_files !== undefined && input.verify_files !== null) {
    if (
      !Array.isArray(input.verify_files) ||
      input.verify_files.some((v) => typeof v !== 'string' || v.length === 0)
    ) {
      return {
        error: {
          ok: false,
          code: 'invalid_verify_files',
          message: 'verify_files must be a non-empty array of non-empty strings when provided',
        },
      };
    }
    if (input.verify_files.length > 0) verifyFiles = [...input.verify_files];
  }

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
    fileName: input.file_name.trim(),
    projectUrl: input.project_url,
    extractPath,
    verifyFiles,
    machines,
  };
}

/**
 * Create a project distribution and fan-out `distribute_project` commands.
 *
 * Steps (mirrors `createDeployment`):
 *   1. validate body
 *   2. read `sites/{siteId}.distributionQuota` (default 100), reject 413 if over
 *   3. write the distribution doc with `status: 'pending'` + targets[]
 *   4. fan out `distribute_project` commands via wave 2.2 helper
 *   5. flip parent doc to `status: 'in_progress'`
 *   6. emit `distribution_mutated` audit event
 */
export async function createDistribution(
  input: CreateDistributionInput,
  ctx: CreateDistributionContext,
): Promise<CreateDistributionResult> {
  const validated = validateInput(input);
  if ('error' in validated) return validated.error;

  const db = ctx.db ?? getAdminDb();
  const now = ctx.now ?? (() => Date.now());

  // Per-site quota check — read `sites/{siteId}.distributionQuota` (mirrors
  // deployments' `deployQuota`). Missing or invalid → fall back to default.
  const siteSnap = await db.collection('sites').doc(ctx.siteId).get();
  const siteData = siteSnap.exists ? (siteSnap.data() ?? {}) : {};
  const quotaRaw = (siteData as Record<string, unknown>).distributionQuota;
  const maxTargets =
    typeof quotaRaw === 'number' && Number.isFinite(quotaRaw) && quotaRaw > 0
      ? Math.floor(quotaRaw)
      : DEFAULT_DISTRIBUTION_MAX_TARGETS;

  if (validated.machines.length > maxTargets) {
    return {
      ok: false,
      code: 'over_quota',
      message: `requested ${validated.machines.length} target machines but max-targets-per-distribution on this site is ${maxTargets}`,
      details: { max_targets: maxTargets, requested: validated.machines.length },
    };
  }

  const distributionId = `project-dist-${now()}`;
  const distributionRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('project_distributions')
    .doc(distributionId);

  const targets = validated.machines.map((machineId) => ({
    machineId,
    status: 'pending' as const,
  }));

  // Build the parent doc. firestore.rules requires `name`, `file_name`,
  // `targets`, `status`, `createdAt`. Optional fields are omitted entirely
  // when not set — Firestore rejects `undefined`.
  const distributionData: Record<string, unknown> = {
    name: validated.name,
    file_name: validated.fileName,
    project_url: validated.projectUrl,
    targets,
    createdAt: FieldValue.serverTimestamp(),
    status: 'pending',
    createdBy: ctx.actorIdentifier,
    auditCorrelationId: ctx.correlationId,
  };
  if (validated.extractPath) distributionData.extract_path = validated.extractPath;
  if (validated.verifyFiles && validated.verifyFiles.length > 0) {
    distributionData.verify_files = validated.verifyFiles;
  }

  await distributionRef.set(distributionData);

  // Fan out `distribute_project` commands via the wave-2.2 helper. The
  // helper handles chunked concurrency, lifecycle stamping, and threading
  // the correlation id into every command's metadata.
  // Use underscores in the commandIdPrefix to avoid Firestore field-path
  // hyphen handling (matches the legacy hook prefix shape).
  const sanitizedDistributionId = distributionId.replace(/-/g, '_');
  const commandIdPrefix = `distribute_${sanitizedDistributionId}`;

  await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: validated.machines,
    correlationId: ctx.correlationId,
    db,
    now,
    builder: () => {
      const commandData: Record<string, unknown> = {
        type: 'distribute_project',
        project_url: validated.projectUrl,
        // Agent reads `project_name` from the command payload; keep the
        // legacy field name so we don't have to touch agent-side code.
        project_name: validated.fileName,
        distribution_id: distributionId,
        status: 'pending',
      };
      if (validated.extractPath) commandData.extract_path = validated.extractPath;
      if (validated.verifyFiles && validated.verifyFiles.length > 0) {
        commandData.verify_files = validated.verifyFiles;
      }
      return { commandIdPrefix, commandData };
    },
  });

  await distributionRef.update({ status: 'in_progress' });

  try {
    emitMutation({
      kind: 'distribution_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: distributionId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/project-distributions`,
        method: 'POST',
        verb: 'create',
        target_count: validated.machines.length,
        file_name: validated.fileName,
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    // emitMutation is fire-and-forget by design, but defensive logging here
    // catches any sync throw before the network handoff.
    logger.warn('[createDistribution] mutation emit threw synchronously', {
      context: 'createDistribution',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    distributionId,
    siteId: ctx.siteId,
    status: 'in_progress',
    targets,
  };
}
