/**
 * GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}
 *
 * Poll a queued command's status. Reads from three Firestore command
 * documents (`pending`, `in_progress`-implicit, `completed`) and synthesizes
 * a unified status. For `capture_screenshot` commands that completed and
 * persisted a `screenshot_path`, mints a fresh 1-hour signed read URL into
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
    // `pending → completed` on terminal status; intermediate `in_progress`
    // is signalled by a status field on the pending entry. We read serially
    // (rather than parallel) so the relative order is deterministic for
    // tests + Firestore's per-collection read budget.
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
    const status: CommandStatus =
      rawStatus === 'failed' || rawStatus === 'error'
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
    const rawStatus = typeof data.status === 'string' ? data.status : 'pending';
    const status: CommandStatus =
      rawStatus === 'in_progress' || rawStatus === 'running'
        ? 'in_progress'
        : 'pending';
    return { status, data, source: 'pending' };
  }

  return null;
}
