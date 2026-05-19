/**
 * `owlette site list | get`.
 *
 * Drives:
 *   GET /api/sites
 *   GET /api/sites/{siteId}
 *
 * Both verbs render a plain-ascii table / key-value detail by default and
 * emit structured JSON when `--json` is passed at the program level.
 *
 * Read-only in v1: site create / update / delete stays in the dashboard.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { isJson, renderTable } from '../lib/output';

interface SiteListItem {
  id: string;
  name: string;
  plan: string | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
}

interface SiteDetail {
  id: string;
  name: string;
  plan: string | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
}

export function registerSiteCommands(program: Command): void {
  const site =
    (program.commands.find((c) => c.name() === 'site') as Command | undefined) ??
    program.command('site').description('list + inspect sites');

  // Overwrite any earlier stub description so the help text stays
  // canonical regardless of registration order.
  site.description('list + inspect sites');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['list', 'get'] as const) {
    const existing = site.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = site.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- list -------------------- */

  site
    .command('list')
    .description('list sites the caller has access to')
    .action(async (_opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(`${apiUrl}/api/sites`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        sites?: SiteListItem[];
        detail?: string;
      };
      if (!res.ok) {
        fatal(`GET /api/sites failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      const sites = data.sites ?? [];

      if (json) {
        process.stdout.write(JSON.stringify({ sites }, null, 2) + '\n');
        return;
      }

      if (sites.length === 0) {
        process.stdout.write('(no sites)\n');
        return;
      }

      const rows = sites.map((s) => [
        s.id,
        s.name,
        s.plan ?? '',
        s.timezone ?? '',
        s.createdAt ?? '',
      ]);
      process.stdout.write(renderTable(['id', 'name', 'plan', 'timezone', 'createdAt'], rows));
    });

  /* -------------------- get -------------------- */

  site
    .command('get <siteId>')
    .description('print the detail record for one site')
    .action(async (siteId: string, _opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(`${apiUrl}/api/sites/${encodeURIComponent(siteId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as SiteDetail & { detail?: string };
      if (!res.ok) {
        fatal(`GET /api/sites/${siteId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatSiteDetail(data));
    });
}

/* --------------------------------------------------------------------- */
/*  formatters                                                           */
/* --------------------------------------------------------------------- */

function formatSiteDetail(s: SiteDetail): string {
  const out: string[] = [];
  out.push(`id         ${s.id}`);
  out.push(`name       ${s.name}`);
  out.push(`plan       ${s.plan ?? '(none)'}`);
  out.push(`timezone   ${s.timezone ?? '(none)'}`);
  out.push(`owner      ${s.owner ?? '(none)'}`);
  out.push(`createdAt  ${s.createdAt ?? '(unknown)'}`);
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
  formatSiteDetail,
  renderTable,
};
