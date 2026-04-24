/**
 * `roost roost list | get | diff` — wave 4.4.
 *
 * Drives:
 *   GET /api/roosts?siteId=...&limit=...&cursor=...
 *   GET /api/roosts/{id}?siteId=...
 *   GET /api/roosts/{id}/manifests/{manifestId}/diff?siteId=...&against=...
 *
 * Each command renders a plain-ascii table by default and emits
 * structured JSON when `--json` is passed at the program level.
 *
 * The list command walks the server's cursor pagination until exhausted
 * (or `--limit` reaches zero), unless `--page-size N` caps a single
 * page.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';

interface RoostListItem {
  roostId: string;
  siteId: string;
  name: string;
  targets: string[];
  currentManifestId: string | null;
  previousManifestId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
}

interface RoostDetail {
  roostId: string;
  siteId: string;
  name: string;
  targets: string[];
  extractPath: string | null;
  schemaVersion: number;
  currentManifestId: string | null;
  previousManifestId: string | null;
  manifestUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  currentManifest: ManifestSummary | null;
  previousManifest: ManifestSummary | null;
}

interface ManifestSummary {
  manifestId: string;
  manifestUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
  totalSize: number;
  totalFiles: number;
  parentManifestId: string | null;
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

export function registerRoostInspectCommands(program: Command): void {
  const roost =
    (program.commands.find((c) => c.name() === 'roost') as Command | undefined) ??
    program.command('roost').description('manage roosts + manifests');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['list', 'get', 'diff'] as const) {
    const existing = roost.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = roost.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- list -------------------- */

  roost
    .command('list')
    .description('list roosts on a site (auto-paginates)')
    .requiredOption('--site <siteId>', 'site id to list roosts for')
    .option('--page-size <n>', 'server-side page size (default 20, max 100)', '20')
    .option('--limit <n>', 'stop after fetching this many roosts in total')
    .option('--include-deleted', 'include tombstoned roosts in the result')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const pageSize = clampInt(opts.pageSize, 1, 100, 20);
      const limit = opts.limit ? clampInt(opts.limit, 1, Number.MAX_SAFE_INTEGER, NaN) : NaN;
      const collected: RoostListItem[] = [];
      let cursor = '';

      for (;;) {
        const qs = new URLSearchParams({
          siteId: opts.site,
          limit: String(pageSize),
        });
        if (cursor) qs.set('cursor', cursor);
        if (opts.includeDeleted) qs.set('includeDeleted', 'true');

        const res = await fetch(`${apiUrl}/api/roosts?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          roosts?: RoostListItem[];
          nextPageToken?: string;
          detail?: string;
        };
        if (!res.ok) {
          fatal(`GET /api/roosts failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
          return;
        }
        for (const r of data.roosts ?? []) {
          collected.push(r);
          if (Number.isFinite(limit) && collected.length >= limit) break;
        }
        cursor = data.nextPageToken ?? '';
        if (!cursor) break;
        if (Number.isFinite(limit) && collected.length >= limit) break;
      }

      if (json) {
        process.stdout.write(JSON.stringify({ roosts: collected }, null, 2) + '\n');
        return;
      }

      if (collected.length === 0) {
        process.stdout.write('(no roosts)\n');
        return;
      }

      const rows = collected.map((r) => [
        r.roostId,
        r.name,
        r.currentManifestId ?? '(none)',
        String(r.targets.length),
        r.deletedAt ? 'tombstoned' : 'active',
        r.updatedAt ?? '',
      ]);
      process.stdout.write(renderTable(['id', 'name', 'current', 'targets', 'status', 'updated'], rows));
    });

  /* -------------------- get -------------------- */

  roost
    .command('get <roostId>')
    .description('print the detail record for one roost')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .action(async (roostId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const qs = new URLSearchParams({ siteId: opts.site });
      const res = await fetch(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as RoostDetail & { detail?: string };
      if (!res.ok) {
        fatal(`GET /api/roosts/${roostId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatRoostDetail(data));
    });

  /* -------------------- diff -------------------- */

  roost
    .command('diff <roostId>')
    .description('diff two manifests on a roost')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .requiredOption('--against <manifestId>', '"from" manifest id to diff against')
    .option(
      '--manifest <manifestId>',
      '"to" manifest id (default: current manifest of the roost)',
    )
    .action(async (roostId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      // Resolve the "to" manifest id: explicit flag, or the current manifest.
      let toManifestId = opts.manifest as string | undefined;
      if (!toManifestId) {
        const qs = new URLSearchParams({ siteId: opts.site });
        const res = await fetch(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => ({}))) as RoostDetail & { detail?: string };
        if (!res.ok) {
          fatal(
            `GET /api/roosts/${roostId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
          );
          return;
        }
        toManifestId = data.currentManifestId ?? undefined;
        if (!toManifestId) {
          fatal('roost has no currentManifestId; pass --manifest <id> explicitly');
          return;
        }
      }

      const qs = new URLSearchParams({ siteId: opts.site, against: opts.against });
      const res = await fetch(
        `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/manifests/${encodeURIComponent(
          toManifestId,
        )}/diff?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as DiffResponse & { detail?: string };
      if (!res.ok) {
        fatal(`GET /diff failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatDiff(data));
    });
}

/* --------------------------------------------------------------------- */
/*  formatters                                                           */
/* --------------------------------------------------------------------- */

function formatRoostDetail(r: RoostDetail): string {
  const out: string[] = [];
  out.push(`id         ${r.roostId}`);
  out.push(`name       ${r.name}`);
  out.push(`site       ${r.siteId}`);
  if (r.extractPath) out.push(`extractPath ${r.extractPath}`);
  out.push(`targets    ${r.targets.length === 0 ? '(none)' : r.targets.join(', ')}`);
  out.push(`current    ${r.currentManifestId ?? '(none)'}`);
  out.push(`previous   ${r.previousManifestId ?? '(none)'}`);
  out.push(`createdAt  ${r.createdAt ?? '(unknown)'}`);
  out.push(`updatedAt  ${r.updatedAt ?? '(unknown)'}`);
  if (r.deletedAt) out.push(`deletedAt  ${r.deletedAt} (tombstoned)`);
  if (r.currentManifest) {
    out.push('');
    out.push(`current manifest:`);
    out.push(`  id         ${r.currentManifest.manifestId}`);
    out.push(`  files      ${r.currentManifest.totalFiles}`);
    out.push(`  bytes      ${humanBytes(r.currentManifest.totalSize)}`);
    if (r.currentManifest.createdBy) out.push(`  createdBy  ${r.currentManifest.createdBy}`);
    if (r.currentManifest.createdAt) out.push(`  createdAt  ${r.currentManifest.createdAt}`);
  }
  return out.join('\n') + '\n';
}

function formatDiff(d: DiffResponse): string {
  const out: string[] = [];
  out.push(
    `diff ${truncate(d.against, 12)} → ${truncate(d.manifestId, 12)} (roost ${d.roostId})`,
  );
  out.push(
    `  summary: +${d.summary.added} -${d.summary.removed} ~${d.summary.changed} ` +
      `=${d.summary.unchanged} (${d.summary.netBytesDelta >= 0 ? '+' : ''}${humanBytes(
        d.summary.netBytesDelta,
      )})`,
  );
  out.push('');

  for (const f of d.added) {
    out.push(`  + ${f.path}   ${humanBytes(f.size)}`);
  }
  for (const f of d.removed) {
    out.push(`  - ${f.path}   ${humanBytes(f.size)}`);
  }
  for (const f of d.modified) {
    const delta = f.toSize - f.fromSize;
    const sign = delta >= 0 ? '+' : '';
    out.push(`  ~ ${f.path}   ${humanBytes(f.fromSize)} → ${humanBytes(f.toSize)} (${sign}${humanBytes(delta)})`);
  }

  if (!d.summary.hasChanges) {
    out.push('  (no changes — manifests are functionally identical)');
  }

  return out.join('\n') + '\n';
}

function renderTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) => {
    const max = rows.reduce((w, r) => Math.max(w, (r[i] ?? '').length), h.length);
    return max;
  });
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').replace(/\s+$/, '');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [fmt(headers), sep, ...rows.map(fmt)];
  return lines.join('\n') + '\n';
}

/* --------------------------------------------------------------------- */
/*  util                                                                 */
/* --------------------------------------------------------------------- */

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const globals = cmd.optsWithGlobals();
  const { apiUrl, token } = loadConfig({ profile: globals.profile });
  if (!token) {
    process.stderr.write(
      'roost: no token configured. run `roost auth login` or set ROOST_TOKEN.\n',
    );
    process.exitCode = 2;
    return { apiUrl, token: null, json: globals.json === true };
  }
  return { apiUrl, token, json: globals.json === true };
}

function fatal(msg: string): void {
  process.stderr.write(`roost: ${msg}\n`);
  process.exitCode = 1;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function humanBytes(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = abs;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${sign}${v.toFixed(v < 10 && u > 0 ? 2 : 1)} ${units[u]}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** Export for unit tests. */
export const _internals = {
  formatRoostDetail,
  formatDiff,
  renderTable,
  humanBytes,
  truncate,
};
