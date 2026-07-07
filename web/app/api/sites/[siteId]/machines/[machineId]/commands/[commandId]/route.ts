/**
 * GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}
 *
 * Poll a queued command's status. Reads from two Firestore command
 * documents (`pending` and `completed`) and synthesizes a unified status.
 * Progress markers (`running` restart-safety marker, `downloading`,
 * `installing`) live on the `completed` doc as NON-terminal statuses and
 * surface as `in_progress` — only the whitelisted terminal statuses
 * (`completed`/`failed`/`error`/`cancelled`) resolve the command. For
 * `capture_screenshot` commands that completed and persisted a
 * `screenshot_path`, mints a fresh 1-hour signed read URL into
 * `result.screenshot_url` per request — never persists the URL itself.
 *
 * Auth: `machine=<id>:read` (api-key) OR site membership (session/id-token).
 *
 * api-sprint wave 2 — track 2A (machine-api MVP).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import { issueScreenshotReadUrl } from '@/lib/screenshotStorage.server';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string; commandId: string }>;
}

const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{1,80}$/;

type CommandStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * A completed-doc entry only resolves the command when its `status` is one of
 * these. The agent also writes NON-terminal markers to the completed doc —
 * `running` (restart-safety marker written at command start), `downloading`,
 * and `installing` (deployment progress) — which must surface as `in_progress`,
 * not `completed`. `cancelled` has no dedicated CommandStatus variant, so it is
 * mapped to `failed` (surfacing the agent's cancellation error) at resolve time.
 */
const TERMINAL_COMMAND_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
]);

interface CommandLookup {
  status: CommandStatus;
  data: Record<string, unknown>;
  source: 'pending' | 'completed';
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId, commandId } = await params;

    if (!COMMAND_ID_RE.test(commandId)) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'invalid commandId',
        status: 400,
        detail: 'commandId must match /^cmd_[A-Za-z0-9_-]{1,80}$/',
      });
    }

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const commandsCol = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands');

    // Read pending first, then completed. The agent moves a command from
    // `pending → completed` on terminal status, and writes intermediate
    // progress markers (`running`/`downloading`/`installing`) to the
    // `completed` doc as non-terminal statuses (never to the pending entry).
    // We read serially (rather than parallel) so the relative order is
    // deterministic for tests + Firestore's per-collection read budget.
    const pendingSnap = await commandsCol.doc('pending').get();
    const completedSnap = await commandsCol.doc('completed').get();

    const lookup = resolveCommand(commandId, pendingSnap, completedSnap);
    if (!lookup) {
      return problem({
        type: ProblemType.NotFound,
        title: 'command not found',
        status: 404,
        detail: `command ${commandId} not found on machine ${machineId}`,
      });
    }

    const cmd = lookup.data;

    // Build result envelope. For capture_screenshot completions, mint a
    // fresh signed read url every poll — the persisted doc only stores the
    // storage path so urls always honor a current expiry.
    let result: Record<string, unknown> | undefined;
    if (lookup.status === 'completed') {
      const baseResult = (cmd.result && typeof cmd.result === 'object'
        ? (cmd.result as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      result = { ...baseResult };
      const storagePath =
        typeof cmd.screenshot_path === 'string'
          ? cmd.screenshot_path
          : typeof baseResult.screenshot_path === 'string'
            ? (baseResult.screenshot_path as string)
            : typeof baseResult.storage_path === 'string'
              ? (baseResult.storage_path as string)
              : typeof cmd.storage_path === 'string'
                ? cmd.storage_path
                : null;
      if (storagePath) {
        const signed = await issueScreenshotReadUrl(storagePath);
        if (signed) {
          result.screenshot_url = signed.url;
          result.expires_at = signed.expiresAt;
        }
      }
    }

    const errorVal = cmd.error;
    const errorOut =
      lookup.status === 'failed' && typeof errorVal === 'string'
        ? errorVal
        : undefined;

    const responseBody: Record<string, unknown> = {
      ok: true,
      data: {
        commandId,
        status: lookup.status,
        ...(result && Object.keys(result).length > 0 ? { result } : {}),
        ...(errorOut ? { error: errorOut } : {}),
        createdAt: timestampToIso(cmd.timestamp ?? cmd.createdAt) ?? null,
        updatedAt: timestampToIso(cmd.updatedAt ?? cmd.completedAt) ?? null,
      },
    };

    return applyAuthDeprecations(NextResponse.json(responseBody), auth.scopeCheck);
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/commands/[commandId]:GET',
    );
  }
}

/**
 * Resolve the command's current state from the two queue docs. `completed`
 * wins over `pending` if both exist (the agent writes to `completed` and
 * deletes from `pending` on terminal status, but a brief overlap is
 * possible if the dashboard polls during the transition).
 */
function resolveCommand(
  commandId: string,
  pendingSnap: FirebaseFirestore.DocumentSnapshot,
  completedSnap: FirebaseFirestore.DocumentSnapshot,
): CommandLookup | null {
  const completedAll = (completedSnap.exists ? completedSnap.data() : null) as
    | Record<string, unknown>
    | null;
  const completedEntry = completedAll?.[commandId];
  if (completedEntry && typeof completedEntry === 'object') {
    const data = completedEntry as Record<string, unknown>;
    const rawStatus = typeof data.status === 'string' ? data.status : null;
    // Non-terminal markers (`running`/`downloading`/`installing`, or any
    // unrecognized status) mean the command is still executing — surface as
    // in_progress, never as completed with an empty result.
    if (!rawStatus || !TERMINAL_COMMAND_STATUSES.has(rawStatus)) {
      return { status: 'in_progress', data, source: 'completed' };
    }
    // Terminal. `cancelled` has no dedicated CommandStatus variant, so it maps
    // to `failed` — the agent's cancellation error then surfaces via `error`.
    const status: CommandStatus =
      rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'cancelled'
        ? 'failed'
        : 'completed';
    return { status, data, source: 'completed' };
  }

  const pendingAll = (pendingSnap.exists ? pendingSnap.data() : null) as
    | Record<string, unknown>
    | null;
  const pendingEntry = pendingAll?.[commandId];
  if (pendingEntry && typeof pendingEntry === 'object') {
    const data = pendingEntry as Record<string, unknown>;
    // A command in the pending doc is always awaiting agent pickup — the agent
    // never writes intermediate/terminal status here (progress + terminal
    // states are written to the completed doc, handled above).
    return { status: 'pending', data, source: 'pending' };
  }

  return null;
}
