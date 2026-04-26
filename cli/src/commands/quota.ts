/**
 * `owlette quota show | history`.
 *
 * Drives:
 *   GET /api/sites/{siteId}/quota
 *   GET /api/sites/{siteId}/quota/history?period=<7d|14d|30d|60d|90d>
 *
 * `show` renders the current storage snapshot as a human-readable
 * progress bar in table mode and surfaces any recent alarm firings.
 * `history` renders the per-day rollup as an ascii table with one row
 * per UTC day in the requested window.
 *
 * Both commands round-trip the server's full snapshot when `--json` is
 * passed at the program level — important for users piping output into
 * `jq` or scripting against the API.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { humanBytes, isJson, renderTable } from '../lib/output';

interface QuotaAlarm {
  id: string;
  threshold: number | null;
  firedAt: string | null;
}

interface QuotaSnapshot {
  siteId: string;
  tier: string;
  usedBytes: number;
  pendingBytes: number;
  committedBytes: number;
  limitBytes: number | null;
  fractionUsed: number | null;
  unlimited: boolean;
  lastAlarmLevel: number;
  lastAlarmAt: string | null;
  lastReconciledAt: string | null;
  alarms: QuotaAlarm[];
}

interface QuotaHistoryBucket {
  date: string;
  storageBytesAvg: number | null;
  classAOps: number;
  classBOps: number;
  egressBytes: number;
}

interface QuotaHistory {
  siteId: string;
  period: string;
  days: number;
  daily: QuotaHistoryBucket[];
}

const VALID_PERIODS = ['7d', '14d', '30d', '60d', '90d'] as const;
type QuotaPeriod = (typeof VALID_PERIODS)[number];

export function registerQuotaCommands(program: Command): void {
  const quota =
    (program.commands.find((c) => c.name() === 'quota') as Command | undefined) ??
    program.command('quota').description('inspect site storage + bandwidth quota');

  // Overwrite any earlier stub description so help text stays canonical
  // regardless of registration order.
  quota.description('inspect site storage + bandwidth quota');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['show', 'history'] as const) {
    const existing = quota.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = quota.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- show -------------------- */

  quota
    .command('show')
    .description('current storage snapshot for a site, with alarms')
    .requiredOption('--site <siteId>', 'site id to fetch quota for')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/quota`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as QuotaSnapshot & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/quota failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatQuotaSnapshot(data));
    });

  /* -------------------- history -------------------- */

  quota
    .command('history')
    .description('daily usage rollup over the requested window')
    .requiredOption('--site <siteId>', 'site id to fetch usage history for')
    .option(
      '--period <window>',
      `time window: ${VALID_PERIODS.join(' | ')}`,
      '30d',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const period = opts.period as string;
      if (!VALID_PERIODS.includes(period as QuotaPeriod)) {
        fatal(
          `--period must be one of ${VALID_PERIODS.join(', ')} (got '${period}')`,
        );
        return;
      }

      const qs = new URLSearchParams({ period });
      const res = await fetch(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/quota/history?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as QuotaHistory & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/quota/history failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatQuotaHistory(data));
    });
}

/* --------------------------------------------------------------------- */
/*  formatters                                                           */
/* --------------------------------------------------------------------- */

const BAR_WIDTH = 20;

function formatQuotaSnapshot(q: QuotaSnapshot): string {
  const out: string[] = [];
  out.push(`site       ${q.siteId}`);
  out.push(`tier       ${q.tier}`);
  out.push('');

  if (q.unlimited || q.limitBytes === null) {
    out.push(
      `storage:   ${humanBytes(q.committedBytes)} used (unlimited — byo bucket)`,
    );
  } else {
    out.push(formatProgressLine('storage', q.committedBytes, q.limitBytes));
  }

  if (q.pendingBytes > 0) {
    out.push(
      `  pending: ${humanBytes(q.pendingBytes)} (in-flight uploads, not yet committed)`,
    );
  }

  if (q.lastReconciledAt) {
    out.push(`  reconciled at ${q.lastReconciledAt}`);
  }

  if (q.alarms.length > 0) {
    out.push('');
    out.push(`alarms (${q.alarms.length}):`);
    for (const a of q.alarms) {
      const pct = a.threshold !== null ? `${Math.round(a.threshold * 100)}%` : '?';
      out.push(`  - ${a.firedAt ?? '(unknown time)'}  threshold ${pct}`);
    }
  } else if (q.lastAlarmLevel > 0) {
    out.push('');
    out.push(`last alarm level: ${Math.round(q.lastAlarmLevel * 100)}% (${q.lastAlarmAt ?? 'unknown time'})`);
  }

  return out.join('\n') + '\n';
}

/**
 * Render a single quota dimension as `<label>: <used> / <limit> (NN%) [bar]`.
 * `limit` must be > 0; callers handle the unlimited / null case separately.
 */
function formatProgressLine(label: string, used: number, limit: number): string {
  const fraction = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const pct = Math.round(fraction * 100);
  const filled = Math.round(fraction * BAR_WIDTH);
  const bar = '#'.repeat(filled) + '.'.repeat(BAR_WIDTH - filled);
  return `${label}: ${humanBytes(used)} / ${humanBytes(limit)} (${pct}%) [${bar}]`;
}

function formatQuotaHistory(h: QuotaHistory): string {
  const out: string[] = [];
  out.push(`site    ${h.siteId}`);
  out.push(`period  ${h.period} (${h.days} day${h.days === 1 ? '' : 's'})`);
  out.push('');

  if (h.daily.length === 0) {
    out.push('(no usage recorded in this window)');
    return out.join('\n') + '\n';
  }

  const rows = h.daily.map((b) => [
    b.date,
    b.storageBytesAvg !== null ? humanBytes(b.storageBytesAvg) : '-',
    String(b.classAOps),
    String(b.classBOps),
    humanBytes(b.egressBytes),
  ]);
  out.push(
    renderTable(['date', 'storage avg', 'class A ops', 'class B ops', 'egress'], rows).trimEnd(),
  );
  return out.join('\n') + '\n';
}

/* --------------------------------------------------------------------- */
/*  util                                                                 */
/* --------------------------------------------------------------------- */

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  if (!token) {
    process.stderr.write(
      'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
    );
    process.exitCode = 2;
    return { apiUrl, token: null, json: isJson(cmd) };
  }
  return { apiUrl, token, json: isJson(cmd) };
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** Export for unit tests. */
export const _internals = {
  formatQuotaSnapshot,
  formatQuotaHistory,
  formatProgressLine,
};
