/**
 * `roost rollback <roostId>` — wave 4.5.
 *
 * Flow:
 *   1. load the roost (GET /api/roosts/{id}) → pick `current` as the
 *      "from" manifest.
 *   2. resolve the "to" manifest: `--to <manifestId>` if given, else the
 *      roost's `previousManifestId`.
 *   3. fetch the diff: GET /api/roosts/{id}/manifests/{to}/diff?against={current}
 *      → print a human-readable summary. Uses the same pretty-print
 *      helpers as `roost roost diff`.
 *   4. confirm (interactive) unless `--yes`. stdin must be a tty for the
 *      prompt; otherwise `--yes` is required (no silent rollbacks from
 *      pipes).
 *   5. POST /api/roosts/{id}/rollback with { siteId, targetManifestId }
 *      and print the resulting pointer flip.
 *
 * Exit codes:
 *   0 — rollback succeeded (or user said 'no' to the prompt)
 *   1 — api call failed
 *   2 — usage / auth / no rollback target / non-tty without --yes
 */

import { Command } from 'commander';
import { createInterface } from 'readline';
import { loadConfig } from '../config';
import { _internals as roostInternals } from './roost';

interface RoostDetail {
  roostId: string;
  siteId: string;
  name: string;
  currentManifestId: string | null;
  previousManifestId: string | null;
  deletedAt: string | null;
  detail?: string;
}

interface DiffResponse {
  manifestId: string;
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
  currentManifestId: string;
  previousManifestId: string | null;
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
    .description('roll a roost back to a previous manifest (prints diff, confirms)')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option('--to <manifestId>', 'explicit target manifest; default: previousManifestId')
    .option('--yes', 'skip the confirmation prompt (required when stdin is not a tty)')
    .action(async (roostId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'roost: no token configured. run `roost auth login` or set ROOST_TOKEN.\n',
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
      if (!roost.currentManifestId) {
        fatal(`roost ${roostId} has no currentManifestId — nothing to roll back from`);
        return;
      }

      // 2. Resolve target.
      const target: string | null =
        (typeof opts.to === 'string' && opts.to.length > 0 ? opts.to : null) ??
        roost.previousManifestId;
      if (!target) {
        fatal(
          'no rollback target: the roost has no previousManifestId. pass --to <manifestId> explicitly.',
        );
        return;
      }
      if (target === roost.currentManifestId) {
        fatal(
          `roost is already pointed at ${target}. pass --to <manifestId> to a different manifest.`,
        );
        return;
      }

      // 3. Fetch + print the diff.
      const diff = await fetchDiff(
        apiUrl,
        token,
        roostId,
        siteId,
        /* to   = */ target,
        /* from = */ roost.currentManifestId,
      );
      if (!diff) {
        process.exitCode = 1;
        return;
      }

      if (json) {
        process.stdout.write(
          JSON.stringify(
            { action: 'plan', roost, target, diff },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          `about to roll back roost '${roost.name}' (${roostId})\n` +
            `  current  ${roost.currentManifestId}\n` +
            `  target   ${target}\n\n`,
        );
        process.stdout.write(roostInternals.formatDiff(diff));
      }

      // 4. Confirm.
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          fatal(
            'stdin is not a tty and --yes was not supplied; refusing to roll back silently.',
          );
          return;
        }
        const ok = await promptYesNo('proceed with rollback? [y/N] ');
        if (!ok) {
          process.stdout.write('rollback cancelled\n');
          return;
        }
      }

      // 5. Fire.
      const result = await performRollback(apiUrl, token, roostId, siteId, target);
      if (!result) {
        process.exitCode = 1;
        return;
      }

      if (json) {
        process.stdout.write(
          JSON.stringify({ action: 'rolled_back', result }, null, 2) + '\n',
        );
      } else {
        process.stdout.write(
          `roost: rolled back\n` +
            `  current   ${result.currentManifestId}\n` +
            `  previous  ${result.previousManifestId ?? '(none)'}\n`,
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
  const res = await fetch(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
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
  const res = await fetch(
    `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/manifests/${encodeURIComponent(to)}/diff?${qs}`,
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
  target: string,
): Promise<RollbackResponse | null> {
  const res = await fetch(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/rollback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ siteId, targetManifestId: target }),
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
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function fatal(msg: string): void {
  process.stderr.write(`roost: ${msg}\n`);
  process.exitCode = 1;
}

/** Exported for unit tests — promptYesNo uses process.stdin which is awkward to mock directly. */
export const _internals = {
  promptYesNo,
};
