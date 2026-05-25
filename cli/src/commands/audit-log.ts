/**
 * `owlette audit-log list | get`.
 *
 * Drives:
 *   GET /api/sites/{siteId}/audit-log?kind=&actor=&since=&page_size=&page_token=
 *   GET /api/sites/{siteId}/audit-log/{recordHash}
 *
 * `list` walks the server's cursor pagination until exhausted or the
 * caller's `--limit` cap is reached, with `--page-size N` controlling
 * the server-side page size and `--cursor T` allowing a resume from a
 * previously-returned `nextPageToken`. CSV `--kind` and `--until`
 * filters are applied client-side because the route handler accepts a
 * single exact-match `kind` and has no `until` filter; `--since`
 * accepts ISO 8601 timestamps OR relative durations (e.g. `24h`,
 * `7d`, `30m`) and is converted to ISO 8601 before being sent.
 *
 * `get` fetches one record by recordHash and renders the full payload
 * including the hash chain (`previousHash` + `hash`) and the server's
 * verification report.
 *
 * Each command renders a plain-ascii table by default and emits the
 * raw server response as JSON when `--json` is passed at the program
 * level — important for users piping output into `jq`.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { isJson, renderTable, truncate, usageFatal } from '../lib/output';

interface AuditLogRecord {
  hash: string;
  kind: string;
  actor: string;
  siteId: string;
  occurredAt: number | null;
  recordedAt: number | null;
  attributes: Record<string, unknown>;
}

interface AuditLogListResponse {
  siteId: string;
  records: AuditLogRecord[];
  next_page_token?: string;
  nextPageToken: string;
}

interface AuditLogVerification {
  ok: boolean;
  hashValid: boolean;
  linkageValid: boolean | null;
  isGenesis: boolean;
  predecessorPresent: boolean;
  reason: string | null;
}

interface AuditLogDetail {
  siteId: string;
  hash: string;
  previousHash: string;
  recordedAt: number;
  event: {
    kind: string;
    siteId: string;
    actor: string;
    occurredAt: number;
    attributes: Record<string, unknown>;
  };
  verification: AuditLogVerification;
}

export function registerAuditLogCommands(program: Command): void {
  const auditLog =
    (program.commands.find((c) => c.name() === 'audit-log') as Command | undefined) ??
    program.command('audit-log').description('inspect site audit log records');

  // Overwrite any earlier stub description so the help text stays
  // canonical regardless of registration order.
  auditLog.description('inspect site audit log records');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['list', 'get'] as const) {
    const existing = auditLog.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = auditLog.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- list -------------------- */

  auditLog
    .command('list')
    .description('list audit log records on a site (auto-paginates)')
    .requiredOption('--site <siteId>', 'site id to list audit records for')
    .option('--kind <csv>', 'comma-separated event kinds to filter by (e.g. api_key_used,signed_url_issued)')
    .option('--actor <actor>', 'exact actor filter (e.g. apiKey:<keyId> or user:<uid>)')
    .option('--since <when>', 'iso 8601 timestamp or relative duration (e.g. 24h, 7d, 30m)')
    .option('--until <when>', 'iso 8601 timestamp or relative duration; filters client-side')
    .option('--limit <n>', 'stop after fetching this many records in total')
    .option('--cursor <token>', 'resume from a previously-returned nextPageToken')
    .option('--page-size <n>', 'server-side page size (default 50, max 200)', '50')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const pageSize = clampInt(opts.pageSize, 1, 200, 50);
      const limit = opts.limit ? clampInt(opts.limit, 1, Number.MAX_SAFE_INTEGER, NaN) : NaN;

      const sinceIso = opts.since ? parseWhen(opts.since, '--since') : null;
      if (opts.since && sinceIso === null) return;
      const untilIso = opts.until ? parseWhen(opts.until, '--until') : null;
      if (opts.until && untilIso === null) return;
      const untilMs = untilIso ? Date.parse(untilIso) : null;

      const kinds = parseKinds(opts.kind);
      // Server only supports single-kind exact-match. When the caller
      // passed exactly one kind, push the filter to the server; for CSV
      // (or zero entries) we filter client-side after the fetch loop.
      const serverKind = kinds.length === 1 ? kinds[0] : null;
      const clientKindSet = kinds.length > 1 ? new Set(kinds) : null;

      const collected: AuditLogRecord[] = [];
      let cursor = typeof opts.cursor === 'string' ? opts.cursor : '';
      let nextPageToken = '';
      let limitReached = false;

      for (;;) {
        const qs = new URLSearchParams({
          page_size: String(pageSize),
        });
        if (cursor) qs.set('page_token', cursor);
        if (serverKind) qs.set('kind', serverKind);
        if (typeof opts.actor === 'string' && opts.actor.length > 0) qs.set('actor', opts.actor);
        if (sinceIso) qs.set('since', sinceIso);

        const res = await fetchWithTimeout(
          `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/audit-log?${qs}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = (await res.json().catch(() => ({}))) as Partial<AuditLogListResponse> & {
          detail?: string;
        };
        if (!res.ok) {
          fatal(
            `GET /api/sites/${opts.site}/audit-log failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
          );
          return;
        }

        const pageRecords = data.records ?? [];
        let stoppedInsidePage = false;
        for (let i = 0; i < pageRecords.length; i++) {
          const r = pageRecords[i]!;
          if (clientKindSet && !clientKindSet.has(r.kind)) continue;
          if (untilMs !== null && r.recordedAt !== null && r.recordedAt > untilMs) continue;
          collected.push(r);
          if (Number.isFinite(limit) && collected.length >= limit) {
            limitReached = true;
            stoppedInsidePage = i < pageRecords.length - 1;
            break;
          }
        }
        const serverNextPageToken = data.next_page_token ?? data.nextPageToken ?? '';
        nextPageToken =
          limitReached && (stoppedInsidePage || serverNextPageToken)
            ? collected[collected.length - 1]?.hash ?? ''
            : serverNextPageToken;
        if (!nextPageToken) break;
        if (limitReached) break;
        cursor = nextPageToken;
      }

      if (json) {
        process.stdout.write(
          JSON.stringify({ records: collected, nextPageToken }, null, 2) + '\n',
        );
        return;
      }

      if (collected.length === 0) {
        process.stdout.write('(no records)\n');
        return;
      }

      const rows = collected.map((r) => [
        formatTimestamp(r.recordedAt),
        r.kind,
        truncate(r.actor, 32),
        r.hash,
      ]);
      process.stdout.write(renderTable(['recordedAt', 'kind', 'actor', 'hash'], rows));
      if (nextPageToken) {
        process.stdout.write(`\nnext cursor: ${nextPageToken}\n`);
      }
    });

  /* -------------------- get -------------------- */

  auditLog
    .command('get <recordHash>')
    .description('print one audit record with hash-chain verification')
    .requiredOption('--site <siteId>', 'site id that owns the record')
    .action(async (recordHash: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/audit-log/${encodeURIComponent(recordHash)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as AuditLogDetail & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/audit-log/${recordHash} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatAuditDetail(data));
    });
}

/* --------------------------------------------------------------------- */
/*  formatters                                                           */
/* --------------------------------------------------------------------- */

function formatAuditDetail(r: AuditLogDetail): string {
  const out: string[] = [];
  out.push(`hash         ${r.hash}`);
  out.push(`previousHash ${r.previousHash}`);
  out.push(`site         ${r.siteId}`);
  out.push(`recordedAt   ${formatTimestamp(r.recordedAt)}`);
  out.push('');
  out.push(`event:`);
  out.push(`  kind       ${r.event.kind}`);
  out.push(`  actor      ${r.event.actor}`);
  out.push(`  occurredAt ${formatTimestamp(r.event.occurredAt)}`);
  const attrKeys = Object.keys(r.event.attributes);
  if (attrKeys.length > 0) {
    out.push(`  attributes:`);
    for (const k of attrKeys) {
      const v = r.event.attributes[k];
      const rendered = typeof v === 'string' ? v : JSON.stringify(v);
      out.push(`    ${k} = ${rendered}`);
    }
  }
  out.push('');
  out.push(`verification:`);
  out.push(`  ok                  ${r.verification.ok ? 'yes' : 'no'}`);
  out.push(`  hashValid           ${r.verification.hashValid ? 'yes' : 'no'}`);
  out.push(
    `  linkageValid        ${r.verification.linkageValid === null ? 'n/a' : r.verification.linkageValid ? 'yes' : 'no'}`,
  );
  out.push(`  isGenesis           ${r.verification.isGenesis ? 'yes' : 'no'}`);
  out.push(`  predecessorPresent  ${r.verification.predecessorPresent ? 'yes' : 'no'}`);
  if (r.verification.reason) {
    out.push(`  reason              ${r.verification.reason}`);
  }
  return out.join('\n') + '\n';
}

/** Format a unix-ms timestamp as ISO 8601, or `-` when null. */
function formatTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  return new Date(ms).toISOString();
}

/* --------------------------------------------------------------------- */
/*  util                                                                 */
/* --------------------------------------------------------------------- */

/** Parse a CSV `--kind` string into a deduped, trimmed list of kinds. */
function parseKinds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const DURATION_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a `--since` / `--until` value. Accepts:
 *   - relative durations (`30s`, `15m`, `24h`, `7d`) → resolved to
 *     `now - duration` and returned as ISO 8601
 *   - ISO 8601 strings (or anything `Date.parse` accepts) → returned
 *     as ISO 8601 normalised through `new Date()`
 *
 * Returns null and prints an error on parse failure.
 */
function parseWhen(raw: string, flag: string): string | null {
  const match = DURATION_RE.exec(raw);
  if (match && match[1] && match[2]) {
    const value = Number(match[1]);
    const unitMs = DURATION_MS[match[2]];
    if (unitMs !== undefined) {
      return new Date(Date.now() - value * unitMs).toISOString();
    }
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    usageFatal(`${flag} must be iso 8601 or a relative duration (e.g. 24h, 7d, 30m); got '${raw}'`);
    return null;
  }
  return new Date(parsed).toISOString();
}

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

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Export for unit tests. */
export const _internals = {
  formatAuditDetail,
  formatTimestamp,
  parseKinds,
  parseWhen,
};
