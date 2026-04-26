/**
 * `owlette machine list | get | deployments`.
 *
 * Drives:
 *   GET /api/sites/{siteId}/machines
 *   GET /api/sites/{siteId}/machines/{machineId}
 *   GET /api/sites/{siteId}/machines/{machineId}/deployments
 *
 * Each command renders a plain-ascii table / key-value detail by default
 * and emits structured JSON when `--json` is passed at the program level.
 *
 * Read-only in wave 2: mutations (reboot / shutdown / screenshot /
 * live-view) are wave-3 stubs that ship under a future
 * `owlette-machine-api` plan and are NOT registered here.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { isJson, renderTable } from '../lib/output';

interface RoostSummary {
  roostId: string;
  name: string;
  currentVersionId: string | null;
  versionCounter: number;
}

interface MachineListItem {
  id: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  os: string | null;
  currentRoosts: RoostSummary[];
}

interface MachineMetrics {
  cpu?: number;
  memory?: number;
  disk?: number;
  uptime?: number;
  [key: string]: unknown;
}

interface MachineProcess {
  name?: string;
  status?: string;
  pid?: number | null;
  [key: string]: unknown;
}

interface MachineDetail {
  id: string;
  siteId: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  os: string | null;
  hostname: string | null;
  metrics: MachineMetrics | null;
  processes: MachineProcess[];
}

interface MachineDeployment {
  roostId: string;
  name: string;
  currentVersionId: string | null;
  previousVersionId: string | null;
  versionCounter: number;
  extractPath: string | null;
  reportedVersionId: string | null;
  reportedStatus: string | null;
  reportedAt: string | null;
}

interface MachineDeploymentsResponse {
  siteId: string;
  machineId: string;
  deployments: MachineDeployment[];
}

export function registerMachineCommands(program: Command): void {
  const machine =
    (program.commands.find((c) => c.name() === 'machine') as Command | undefined) ??
    program.command('machine').description('list + inspect machines');

  // Overwrite any earlier stub description so the help text stays
  // canonical regardless of registration order.
  machine.description('list + inspect machines');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['list', 'get', 'deployments'] as const) {
    const existing = machine.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = machine.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- list -------------------- */

  machine
    .command('list')
    .description('list machines on a site with online + last-heartbeat')
    .requiredOption('--site <siteId>', 'site id to list machines for')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as {
        machines?: MachineListItem[];
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/machines failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      const machines = data.machines ?? [];

      if (json) {
        process.stdout.write(JSON.stringify({ machines }, null, 2) + '\n');
        return;
      }

      if (machines.length === 0) {
        process.stdout.write('(no machines)\n');
        return;
      }

      const rows = machines.map((m) => [
        m.id,
        m.name,
        m.online ? 'yes' : 'no',
        m.lastHeartbeat ?? '',
        m.agentVersion ?? '',
        formatRoostSummary(m.currentRoosts),
      ]);
      process.stdout.write(
        renderTable(
          ['id', 'name', 'online', 'last-heartbeat', 'agent', 'roosts'],
          rows,
        ),
      );
    });

  /* -------------------- get -------------------- */

  machine
    .command('get <machineId>')
    .description('print the detail record for one machine (metrics + processes)')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as MachineDetail & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/machines/${machineId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatMachineDetail(data));
    });

  /* -------------------- deployments -------------------- */

  machine
    .command('deployments <machineId>')
    .description('per-roost deployment state for one machine (intended vs reported)')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}/deployments`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as MachineDeploymentsResponse & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/machines/${machineId}/deployments failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      const deployments = data.deployments ?? [];
      if (deployments.length === 0) {
        process.stdout.write('(no roosts target this machine)\n');
        return;
      }

      const rows = deployments.map((d) => [
        d.roostId,
        d.name,
        d.currentVersionId ?? '(none)',
        d.reportedVersionId ?? '(none)',
        d.reportedStatus ?? '(unknown)',
        d.reportedAt ?? '',
      ]);
      process.stdout.write(
        renderTable(
          ['roostId', 'name', 'intended', 'reported', 'status', 'reportedAt'],
          rows,
        ),
      );
    });
}

/* --------------------------------------------------------------------- */
/*  formatters                                                           */
/* --------------------------------------------------------------------- */

function formatRoostSummary(roosts: readonly RoostSummary[] | undefined): string {
  if (!roosts || roosts.length === 0) return '(none)';
  if (roosts.length === 1) {
    const r = roosts[0]!;
    return `${r.name} → ${r.currentVersionId ?? '(none)'}`;
  }
  return `${roosts.length} roosts`;
}

function formatMachineDetail(m: MachineDetail): string {
  const out: string[] = [];
  out.push(`id             ${m.id}`);
  out.push(`name           ${m.name}`);
  out.push(`site           ${m.siteId}`);
  out.push(`online         ${m.online ? 'yes' : 'no'}`);
  out.push(`last-heartbeat ${m.lastHeartbeat ?? '(never)'}`);
  out.push(`agent          ${m.agentVersion ?? '(unknown)'}`);
  out.push(`os             ${m.os ?? '(unknown)'}`);
  out.push(`hostname       ${m.hostname ?? '(unknown)'}`);

  if (m.metrics && Object.keys(m.metrics).length > 0) {
    out.push('');
    out.push('metrics:');
    for (const [k, v] of Object.entries(m.metrics)) {
      out.push(`  ${k.padEnd(12)} ${formatMetricValue(v)}`);
    }
  }

  const procs = Array.isArray(m.processes) ? m.processes : [];
  if (procs.length > 0) {
    out.push('');
    out.push(`processes (${procs.length}):`);
    for (const p of procs) {
      const name = typeof p.name === 'string' ? p.name : '(unnamed)';
      const status = typeof p.status === 'string' ? p.status : '(unknown)';
      const pid = p.pid !== null && p.pid !== undefined ? `pid ${p.pid}` : 'no pid';
      out.push(`  ${name.padEnd(28)} ${status.padEnd(12)} ${pid}`);
    }
  }

  return out.join('\n') + '\n';
}

function formatMetricValue(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return JSON.stringify(v);
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
  formatMachineDetail,
  formatRoostSummary,
  formatMetricValue,
  renderTable,
};
