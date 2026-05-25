/**
 * `owlette rollback <roostId>`.
 *
 * Flow:
 *   1. load the roost (GET /api/roosts/{id}) → pick `current` as the
 *      "from" version.
 *   2. resolve the "to" version: `--to <versionRef>` if given, else the
 *      roost's `previousVersionId`. `<versionRef>` accepts a numeric id
 *      (`3`), `#3`/`v3`, a `vrs_*` opaque id, or alias
 *      `current`/`previous`/`first`.
 *   3. fetch the diff: GET /api/roosts/{id}/versions/{to}/diff?against={current}
 *      → print a human-readable summary. Uses the same pretty-print
 *      helpers as `roost roost diff`.
 *   4. confirm (interactive) unless `--yes`. stdin must be a tty for the
 *      prompt; otherwise `--yes` is required (no silent rollbacks from
 *      pipes).
 *   5. POST /api/roosts/{id}/rollback with { siteId, targetVersion }.
 *      The diff preview resolves number-or-id-or-alias refs first; the
 *      mutation uses that concrete version id so idempotent retries can
 *      replay the same body.
 *
 * Exit codes:
 *   0 — rollback succeeded (or user said 'no' to the prompt)
 *   1 — api call failed
 *   2 — usage / auth / no rollback target / non-tty without --yes
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { usageFatal } from '../lib/output';
import { _internals as roostInternals } from './roost';

interface RoostDetail {
  roostId: string;
  siteId: string;
  name: string;
  currentVersionId: string | null;
  previousVersionId: string | null;
  deletedAt: string | null;
  detail?: string;
}

interface DiffResponse {
  versionId: string;
  fromVersion?: string;
  toVersion?: string;
  against: string;
  roostId: string;
  siteId: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    hasChanges: boolean;
    netBytesDelta: number;
  };
  added: Array<{ path: string; size: number; reason: 'added'; chunks: number }>;
  removed: Array<{ path: string; size: number; reason: 'removed'; chunks: number }>;
  modified: Array<{
    path: string;
    fromSize: number;
    toSize: number;
    reason: 'modified';
    fromChunks: number;
    toChunks: number;
  }>;
}

interface RollbackResponse {
  currentVersionId: string;
  previousVersionId: string | null;
  detail?: string;
}

export function registerRollbackCommand(program: Command): void {
  // Drop any stub left behind by earlier file-load order.
  const existing = program.commands.find((c) => c.name() === 'rollback');
  if (existing) {
    const list = program.commands as Command[];
    const idx = list.indexOf(existing);
    if (idx >= 0) list.splice(idx, 1);
  }

  program
    .command('rollback <roostId>')
    .description('roll a roost back to a previous version (prints diff, confirms)')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option(
      '--to <versionRef>',
      'explicit target version (id, #N, vN, "current", "previous", "first"); default: previousVersionId',
    )
    .option('--yes', 'skip the confirmation prompt (required when stdin is not a tty)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (roostId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }

      const json = globals.json === true;
      const siteId: string = opts.site;

      // 1. Load the roost.
      const roost = await fetchRoost(apiUrl, token, roostId, siteId);
      if (!roost) {
        process.exitCode = 1;
        return;
      }
      if (roost.deletedAt) {
        fatal(`roost ${roostId} is tombstoned — cannot roll back`);
        return;
      }
      if (!roost.currentVersionId) {
        usageFatal(`roost ${roostId} has no currentVersionId — nothing to roll back from`);
        return;
      }

      // 2. Resolve the rollback target. When `--to` is omitted, fall
      // back to the roost's previous version. The flag is forwarded to
      // the server verbatim so it can accept any of the alias / number
      // / id forms the resolver supports.
      const targetRef: string | null =
        (typeof opts.to === 'string' && opts.to.length > 0 ? opts.to : null) ??
        roost.previousVersionId;
      if (!targetRef) {
        usageFatal(
          'no rollback target: the roost has no previousVersionId. pass --to <versionRef> explicitly.',
        );
        return;
      }

      // 3. Fetch + print the diff. We preview the change against the
      // current version using the operator's raw target ref — the diff
      // endpoint runs the same resolver, so whatever `--to` accepts is
      // safe to pipe straight through.
      const diff = await fetchDiff(
        apiUrl,
        token,
        roostId,
        siteId,
        /* to   = */ targetRef,
        /* from = */ roost.currentVersionId,
      );
      if (!diff) {
        process.exitCode = 1;
        return;
      }

      // Refuse a no-op rollback — the diff endpoint resolved both refs
      // and reported identical versions, so there's nothing to flip.
      if (diff.toVersion && diff.fromVersion && diff.toVersion === diff.fromVersion) {
        usageFatal(
          `target version resolves to ${diff.toVersion}, which is already the current version. pass --to <versionRef> to a different version.`,
        );
        return;
      }
      const resolvedTargetVersionId = diff.toVersion ?? diff.versionId;

      if (!json) {
        process.stdout.write(
          `about to roll back roost '${roost.name}' (${roostId})\n` +
            `  current  ${roost.currentVersionId}\n` +
            `  target   ${targetRef}\n\n`,
        );
        process.stdout.write(roostInternals.formatDiff(diff));
      }

      // 4. Confirm.
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          usageFatal(
            'stdin is not a tty and --yes was not supplied; refusing to roll back silently.',
          );
          return;
        }
        const ok = await promptYesNo('proceed with rollback? [y/N] ');
        if (!ok) {
          if (json) {
            process.stdout.write(
              JSON.stringify({ action: 'cancelled', roost, target: targetRef, diff }, null, 2) + '\n',
            );
          } else {
            process.stdout.write('rollback cancelled\n');
          }
          return;
        }
      }

      // 5. Fire.
      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-rollback-${randomUUID()}`;
      let result: RollbackResponse | null;
      try {
        result = await performRollback(
          apiUrl,
          token,
          roostId,
          siteId,
          resolvedTargetVersionId,
          idempotencyKey,
        );
      } catch (err) {
        unconfirmedRollbackFatal({
          operation: `POST /api/roosts/${roostId}/rollback`,
          idempotencyKey,
          targetVersionId: resolvedTargetVersionId,
          cause: err,
        });
        return;
      }
      if (!result) {
        process.exitCode = 1;
        return;
      }

      if (json) {
        process.stdout.write(
          JSON.stringify({ action: 'rolled_back', roost, target: targetRef, diff, result }, null, 2) + '\n',
        );
      } else {
        process.stdout.write(
          `owlette: rolled back\n` +
            `  current   ${result.currentVersionId}\n` +
            `  previous  ${result.previousVersionId ?? '(none)'}\n`,
        );
      }
    });
}

/* --------------------------------------------------------------------- */
/*  http helpers                                                         */
/* --------------------------------------------------------------------- */

async function fetchRoost(
  apiUrl: string,
  token: string,
  roostId: string,
  siteId: string,
): Promise<RoostDetail | null> {
  const qs = new URLSearchParams({ siteId });
  const res = await fetchWithTimeout(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as RoostDetail;
  if (!res.ok) {
    fatal(
      `GET /api/roosts/${roostId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
    );
    return null;
  }
  return data;
}

async function fetchDiff(
  apiUrl: string,
  token: string,
  roostId: string,
  siteId: string,
  to: string,
  from: string,
): Promise<DiffResponse | null> {
  const qs = new URLSearchParams({ siteId, against: from });
  const res = await fetchWithTimeout(
    `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(to)}/diff?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json().catch(() => ({}))) as DiffResponse & { detail?: string };
  if (!res.ok) {
    fatal(`GET /diff failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
    return null;
  }
  return data;
}

async function performRollback(
  apiUrl: string,
  token: string,
  roostId: string,
  siteId: string,
  targetVersion: string,
  idempotencyKey: string,
): Promise<RollbackResponse | null> {
  const res = await fetchWithTimeout(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/rollback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ siteId, targetVersion }),
  });
  const data = (await res.json().catch(() => ({}))) as RollbackResponse & { detail?: string };
  if (!res.ok) {
    fatal(
      `POST /api/roosts/${roostId}/rollback failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
    );
    return null;
  }
  return data;
}

/* --------------------------------------------------------------------- */
/*  prompt                                                               */
/* --------------------------------------------------------------------- */

/**
 * Minimal readline-based yes/no prompt. Defaults to "no" on empty input
 * to match the [y/N] convention — a user hitting return does NOT roll
 * back.
 */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function fatal(msg: string, exitCode = 1): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = exitCode;
}

function unconfirmedRollbackFatal(input: {
  operation: string;
  idempotencyKey: string;
  targetVersionId: string;
  cause: unknown;
}): void {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  process.stderr.write(
    `owlette: ${input.operation} did not return a confirmed response: ${detail}\n` +
      `  The request may or may not have completed.\n` +
      `  Idempotency-Key: ${input.idempotencyKey}\n` +
      `  To retry safely, re-run your original command with \`--to ${input.targetVersionId} --idempotency-key ${input.idempotencyKey}\` appended.\n`,
  );
  process.exitCode = 1;
}

/** Exported for unit tests — promptYesNo uses process.stdin which is awkward to mock directly. */
export const _internals = {
  promptYesNo,
};
