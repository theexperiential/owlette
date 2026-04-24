/**
 * `roost deploy <roostId>` — wave 4.6.
 *
 * Drives POST /api/roosts/{id}/deploy with body:
 *   {
 *     siteId,
 *     manifestId?,      // defaults to the roost's currentManifestId server-side
 *     machines?,        // comma-separated list; overrides the roost's targets[]
 *     scheduleAt?,      // iso8601
 *     dryRun?,
 *   }
 *
 * dry-run returns the server-computed plan (canary / fleet split +
 * resolved extractRoot + manifestUrl) without writing anything. A real
 * deploy creates the rollout doc + queues `sync_pull` commands for the
 * canary wave. scheduleAt with a future time stores a `scheduled`
 * rollout that the wave-4 sweeper will kick off later.
 *
 * Propagates the optional `Idempotency-Key` header — safe because the
 * server's idempotency layer caches the 201 response for 24h, so a
 * retry on network timeout returns the original plan instead of
 * accidentally starting a second rollout.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config';

interface DeployResponse {
  rolloutId: string;
  manifestId: string;
  siteId: string;
  roostId: string;
  stage: 'canary' | 'scheduled' | string;
  canary: string[];
  fleet: string[];
  extractRoot: string;
  manifestUrl: string;
  dryRun?: boolean;
  alreadyRunning?: boolean;
  scheduled?: { at: string; warning: string };
  detail?: string;
}

export function registerDeployCommand(program: Command): void {
  // Drop any stub the index file already registered.
  const existing = program.commands.find((c) => c.name() === 'deploy');
  if (existing) {
    const list = program.commands as Command[];
    const idx = list.indexOf(existing);
    if (idx >= 0) list.splice(idx, 1);
  }

  program
    .command('deploy <roostId>')
    .description('trigger a targeted fan-out (canary → fleet)')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option(
      '--manifest <manifestId>',
      'manifest to deploy (default: the roost\'s currentManifestId)',
    )
    .option('--machines <ids>', 'comma-separated machine ids (overrides roost.targets)')
    .option('--dry-run', 'compute + print the rollout plan without writing')
    .option('--at <iso8601>', 'schedule the rollout for a future timestamp')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted on retries)',
    )
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
      const body: Record<string, unknown> = { siteId: opts.site };

      if (opts.manifest) body.manifestId = opts.manifest;

      if (opts.machines) {
        const machines = String(opts.machines)
          .split(',')
          .map((m: string) => m.trim())
          .filter(Boolean);
        if (machines.length === 0) {
          fatal('--machines must contain at least one non-empty id when provided');
          return;
        }
        body.machines = machines;
      }

      if (opts.at) {
        const parsed = Date.parse(opts.at);
        if (Number.isNaN(parsed)) {
          fatal(`--at '${opts.at}' is not a valid iso8601 timestamp`);
          return;
        }
        body.scheduleAt = new Date(parsed).toISOString();
      }

      if (opts.dryRun) body.dryRun = true;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      if (opts.idempotencyKey) {
        headers['Idempotency-Key'] = String(opts.idempotencyKey);
      } else if (!opts.dryRun) {
        // Auto-key non-dry-run deploys so an accidental retry (network
        // blip, ctrl-c → rerun) doesn't create a second rollout. Dry
        // runs don't mutate anything, so no caching benefit there.
        headers['Idempotency-Key'] = `cli-deploy-${randomUUID()}`;
      }

      const res = await fetch(
        `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/deploy`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as DeployResponse;

      if (!res.ok) {
        fatal(
          `POST /api/roosts/${roostId}/deploy failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatDeployResult(data, roostId));
    });
}

/* --------------------------------------------------------------------- */
/*  formatter                                                            */
/* --------------------------------------------------------------------- */

function formatDeployResult(r: DeployResponse, roostId: string): string {
  const lines: string[] = [];
  const label = r.dryRun
    ? 'dry-run plan'
    : r.alreadyRunning
      ? 'rollout already in flight'
      : r.stage === 'scheduled'
        ? 'scheduled'
        : 'rollout started';

  lines.push(`roost: ${label} for ${roostId}`);
  lines.push(`  manifest      ${r.manifestId}`);
  lines.push(`  stage         ${r.stage}`);
  lines.push(`  extract root  ${r.extractRoot}`);
  lines.push(`  manifest url  ${r.manifestUrl}`);
  if (r.scheduled) {
    lines.push(`  scheduled at  ${r.scheduled.at}`);
    lines.push(`  warning       ${r.scheduled.warning}`);
  }
  lines.push('');
  lines.push(`  canary (${r.canary.length})`);
  if (r.canary.length === 0) {
    lines.push('    (none)');
  } else {
    for (const m of r.canary) lines.push(`    - ${m}`);
  }
  lines.push(`  fleet (${r.fleet.length})`);
  if (r.fleet.length === 0) {
    lines.push('    (none)');
  } else {
    for (const m of r.fleet) lines.push(`    - ${m}`);
  }
  return lines.join('\n') + '\n';
}

function fatal(msg: string): void {
  process.stderr.write(`roost: ${msg}\n`);
  process.exitCode = 1;
}

/** Exported for tests. */
export const _internals = { formatDeployResult };
