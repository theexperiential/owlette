/**
 * Action core: queue a remote command on a machine.
 *
 * security-boundary-migration wave 3.1. Lifted from the body of
 * `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts`
 * (api-sprint wave 2 — track 2A) so it can be reused from the public
 * route + future server-side callers (cortex tool dispatch via
 * `invokeAsSystem`, scheduled jobs).
 *
 * Allowlist enforcement, machine-offline check, command-id mint,
 * `stampCommand`-based lifecycle write, and audit emission all happen
 * here. Auth + capability + rate-limit + idempotency are the wrapper's
 * job — this function assumes it's running inside an
 * `authorizedSiteHandler` (or `invokeAsSystem`) call frame and that the
 * caller has already established the actor's right to act on the
 * site/machine.
 *
 * The allowlist is intentionally narrow — every supported `type` maps
 * to one of the known agent command handlers. Anything outside the list
 * is rejected with a 400 (`unsupported_command_type`) so api-key
 * callers can't spawn arbitrary commands. Live-view types are
 * deliberately absent and remain a separate wave-4 surface.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { stampCommand } from '@/lib/commandLifecycle';
import { emitMutation } from '@/lib/auditLogClient';
import type { Actor } from '@/lib/capabilities';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * Allowlist of command types this action will queue. Mirrors the union
 * of types observed in the wave-1.1 write inventory for
 * `MACHINE_EXEC_COMMAND`. Names match the agent-side handlers exactly
 * (verified against `agent/src/owlette_service.py`).
 *
 * - `reboot_machine` / `shutdown_machine` / `cancel_reboot` /
 *   `dismiss_reboot_pending` — scoped operator actions.
 * - `capture_screenshot` — single-shot screenshot.
 * - `start_live_view` / `stop_live_view` - live-view session control.
 * - `apply_display_topology` / `ack_display_topology` /
 *   `enumerate_display_modes` / `test_display_apply` — display editor
 *   command surface (used by `useDisplayActions`).
 * - `kill_process` - process-control command emitted by `useFirestore`.
 * - `update_owlette` — agent self-update command issued by
 *   `lib/firebase.ts:sendOwletteUpdateCommand`.
 */
export const ALLOWED_COMMAND_TYPES: ReadonlySet<string> = new Set<string>([
  'reboot_machine',
  'shutdown_machine',
  'cancel_reboot',
  'dismiss_reboot_pending',
  'capture_screenshot',
  'start_live_view',
  'stop_live_view',
  'restart_process',
  'start_process',
  'kill_process',
  'set_launch_mode',
  'apply_display_topology',
  'ack_display_topology',
  'enumerate_display_modes',
  'test_display_apply',
  'mcp_tool_call',
  'update_owlette',
]);

export interface ExecuteMachineCommandInput {
  /** Command type — must be in `ALLOWED_COMMAND_TYPES`. */
  type: string;
  /**
   * Per-type validated fields. Caller (route shim or system invoker)
   * is responsible for filtering / normalizing these — this function
   * does NOT re-validate them; it merges them into the firestore command
   * envelope as-is alongside the lifecycle stamp.
   *
   * Reserved keys (`type`, `status`, `timestamp`, `siteId`, `machineId`,
   * `queuedBy`, `createdAt`, `expiresAt`, `auditCorrelationId`) in
   * `payload` are silently overwritten by the canonical values this
   * action sets.
   */
  payload: Record<string, unknown>;
}

export interface ExecuteMachineCommandResult {
  commandId: string;
}

export interface ExecuteMachineCommandContext {
  siteId: string;
  /** Target machine within `siteId`. */
  machineId: string;
  /**
   * Acting principal (user or system). The wrapper produces this; the
   * action core uses it as a forward-compat hook for any per-actor
   * branching. Currently only the formatted `auditActor` string is read.
   */
  actor: Actor;
  /**
   * Pre-formatted audit-actor descriptor (`user:<uid>`,
   * `apiKey:<keyId>`, or `system:<name>`). The route shim picks the
   * right form based on `auth.keyContext`; system callers pass
   * `system:<actorName>`.
   */
  auditActor: string;
  /**
   * Optional correlation id from `authorizedSiteHandler` /
   * `invokeAsSystem`. Stamped into the command envelope so the agent
   * write-back can be correlated with the originating audit row.
   */
  correlationId?: string;
}

export class ExecuteMachineCommandError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'ExecuteMachineCommandError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Reserved keys this action controls. Anything in `input.payload` under
 * these keys is silently dropped to avoid the caller spoofing the
 * `queuedBy` / `status` / lifecycle fields.
 */
const RESERVED_PAYLOAD_KEYS: ReadonlySet<string> = new Set<string>([
  'type',
  'status',
  'timestamp',
  'siteId',
  'machineId',
  'queuedBy',
  'createdAt',
  'expiresAt',
  'auditCorrelationId',
]);

function stripReservedKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_PAYLOAD_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface ExecuteMachineCommandOptions {
  /**
   * Inject a Firestore instance — tests pass a mock; production callers
   * omit this and the helper uses `getAdminDb()`. Same pattern as
   * `writeCommandFanOut`.
   */
  db?: ReturnType<typeof getAdminDb>;
  /** Override the wall-clock `now` — unit tests use this for deterministic command ids. */
  now?: () => number;
}

export async function executeMachineCommand(
  ctx: ExecuteMachineCommandContext,
  input: ExecuteMachineCommandInput,
  options: ExecuteMachineCommandOptions = {},
): Promise<ExecuteMachineCommandResult> {
  // ── input validation ────────────────────────────────────────────────────
  if (typeof ctx.siteId !== 'string' || ctx.siteId.length === 0) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'ctx.siteId is required',
    );
  }
  if (typeof ctx.machineId !== 'string' || ctx.machineId.length === 0) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'ctx.machineId is required',
    );
  }
  if (typeof input.type !== 'string' || input.type.trim().length === 0) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'field `type` is required and must be a non-empty string',
    );
  }
  const cmdType = input.type.trim();
  if (!ALLOWED_COMMAND_TYPES.has(cmdType)) {
    throw new ExecuteMachineCommandError(
      400,
      'unsupported_command_type',
      `command type '${cmdType}' is not accepted on this endpoint. ` +
        `allowed types: ${[...ALLOWED_COMMAND_TYPES].sort().join(', ')}`,
    );
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'field `payload` must be an object',
    );
  }

  const safePayload = stripReservedKeys(input.payload);
  const { siteId, machineId } = ctx;
  const now = options.now ? options.now() : Date.now();

  // ── machine offline check ───────────────────────────────────────────────
  const db = options.db ?? getAdminDb();
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const machineSnap = await machineRef.get();
  if (!machineSnap.exists) {
    throw new ExecuteMachineCommandError(
      404,
      'not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }
  const machineData = machineSnap.data() ?? {};
  if (machineData.online === false) {
    throw new ExecuteMachineCommandError(
      409,
      'machine_offline',
      `machine ${machineId} is currently offline; commands cannot be queued ` +
        `until it reconnects`,
    );
  }

  // ── write command to pending queue ──────────────────────────────────────
  const commandId = `cmd_${now.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  const stamped = stampCommand(
    {
      type: cmdType,
      ...safePayload,
      siteId,
      machineId,
      timestamp: FieldValue.serverTimestamp(),
      status: 'pending',
      queuedBy: ctx.auditActor,
    },
    { auditCorrelationId: ctx.correlationId, now: () => now },
  );

  await pendingRef.set({ [commandId]: stamped }, { merge: true });

  emitMutation({
    kind: 'machine_command_dispatched',
    siteId,
    actor: ctx.auditActor,
    targetId: commandId,
    attributes: {
      commandType: cmdType,
      endpoint: `/api/sites/${siteId}/machines/${machineId}/commands`,
      method: 'POST',
      machineId,
    },
  });

  return { commandId };
}
