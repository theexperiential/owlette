/**
 * POST /api/sites/{siteId}/machines/{machineId}/commands
 *
 * Queue a remote command on a machine. Public counterpart of
 * `/api/admin/commands/send`; restricted to a small allowlist of operator-
 * safe types (`reboot_machine`, `shutdown_machine`, `capture_screenshot`)
 * so api-key callers can't spawn arbitrary commands. Live-view is
 * intentionally absent — that surface is a wave-4 spike.
 *
 * Auth: `machine=<id>:write` (api-key) OR site membership (session/id-token).
 * Idempotency: required via `Idempotency-Key`. Replays return the cached
 * 202 envelope with `Idempotent-Replayed: true`.
 *
 * Errors:
 *   - 400 `unsupported_command_type` — type not in the allowlist
 *   - 400 validation failures (missing type, bad params)
 *   - 403 `scope_insufficient` — api key lacks the right scope
 *   - 409 `machine_offline` — `machines/{id}.online === false`
 *
 * api-sprint wave 2 — track 2A (machine-api MVP).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireMachineAuthAndScope,
} from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

/**
 * Allowlist of command types this public endpoint will queue. Mirrors the
 * api-surface spec for track 2A. Any other type → 400 `unsupported_command_type`.
 */
const ALLOWED_COMMAND_TYPES = new Set<string>([
  'reboot_machine',
  'shutdown_machine',
  'capture_screenshot',
]);

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

interface CommandBody {
  type?: unknown;
  params?: unknown;
  timeout_seconds?: unknown;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CommandBody;

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
    if (!auth.ok) return auth.response;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        // ── body validation ────────────────────────────────────────────
        if (typeof body.type !== 'string' || body.type.trim().length === 0) {
          return problemValidation('field `type` is required and must be a non-empty string', {
            'body.type': ['required non-empty string'],
          });
        }
        const cmdType = body.type.trim();
        if (!ALLOWED_COMMAND_TYPES.has(cmdType)) {
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'unsupported command type',
            status: 400,
            detail:
              `command type '${cmdType}' is not accepted on this endpoint. ` +
              `allowed types: ${[...ALLOWED_COMMAND_TYPES].sort().join(', ')}`,
            code: 'unsupported_command_type',
          });
        }

        const rawParams = body.params;
        if (rawParams !== undefined && rawParams !== null) {
          if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
            return problemValidation('field `params` must be an object when provided', {
              'body.params': ['must be an object'],
            });
          }
        }
        const inputParams = (rawParams ?? {}) as Record<string, unknown>;

        // Timeout (optional). Clamp to [1, MAX_TIMEOUT_S].
        let timeoutSeconds: number = DEFAULT_TIMEOUT_S;
        if (body.timeout_seconds !== undefined && body.timeout_seconds !== null) {
          const n = Number(body.timeout_seconds);
          if (!Number.isFinite(n) || n <= 0) {
            return problemValidation(
              'timeout_seconds must be a positive number when provided',
              { 'body.timeout_seconds': ['must be > 0'] },
            );
          }
          timeoutSeconds = Math.min(Math.floor(n), MAX_TIMEOUT_S);
        }

        // Per-type param normalization. Anything outside the allowlist is
        // dropped to prevent field injection on the agent side.
        const safeParams: Record<string, unknown> = {};
        if (cmdType === 'reboot_machine' || cmdType === 'shutdown_machine') {
          if (inputParams.delay_seconds !== undefined) {
            const d = Number(inputParams.delay_seconds);
            if (!Number.isFinite(d) || d < 0) {
              return problemValidation(
                'params.delay_seconds must be ≥ 0 when provided',
                { 'body.params.delay_seconds': ['must be ≥ 0'] },
              );
            }
            safeParams.delay_seconds = Math.floor(d);
          }
        } else if (cmdType === 'capture_screenshot') {
          // monitor: 'all' | 'primary' | non-negative integer.
          if (inputParams.monitor !== undefined) {
            const m = inputParams.monitor;
            if (typeof m === 'string') {
              if (m !== 'all' && m !== 'primary') {
                return problemValidation(
                  'params.monitor must be "all", "primary", or a non-negative integer',
                  { 'body.params.monitor': ['invalid value'] },
                );
              }
              safeParams.monitor = m;
            } else if (typeof m === 'number') {
              if (!Number.isFinite(m) || m < 0 || !Number.isInteger(m)) {
                return problemValidation(
                  'params.monitor must be a non-negative integer when numeric',
                  { 'body.params.monitor': ['invalid value'] },
                );
              }
              safeParams.monitor = m;
            } else {
              return problemValidation(
                'params.monitor must be "all", "primary", or a non-negative integer',
                { 'body.params.monitor': ['invalid value'] },
              );
            }
          }
        }

        // ── machine offline check ──────────────────────────────────────
        const db = getAdminDb();
        const machineRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId);
        const machineSnap = await machineRef.get();
        if (!machineSnap.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'machine not found',
            status: 404,
            detail: `machine ${machineId} not found on site ${siteId}`,
          });
        }
        const machineData = machineSnap.data() ?? {};
        if (machineData.online === false) {
          return problem({
            type: ProblemType.Conflict,
            title: 'machine offline',
            status: 409,
            detail:
              `machine ${machineId} is currently offline; commands cannot be queued ` +
              `until it reconnects`,
            code: 'machine_offline',
          });
        }

        // ── write command to pending queue ─────────────────────────────
        const commandId = `cmd_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;

        const pendingRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('pending');

        const commandPayload: Record<string, unknown> = {
          type: cmdType,
          ...safeParams,
          timeout_seconds: timeoutSeconds,
          siteId,
          machineId,
          timestamp: FieldValue.serverTimestamp(),
          status: 'pending',
          queuedBy: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
        };

        await pendingRef.set({ [commandId]: commandPayload }, { merge: true });

        emitMutation({
          kind: 'machine_command_dispatched',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: commandId,
          attributes: {
            commandType: cmdType,
            endpoint: `/api/sites/${siteId}/machines/${machineId}/commands`,
            method: 'POST',
            machineId,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json(
            {
              ok: true,
              data: {
                commandId,
                status: 'pending',
              },
            },
            { status: 202 },
          ),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/commands:POST');
  }
}
