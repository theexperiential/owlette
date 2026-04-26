/**
 * `owlette process …` — process lifecycle on machines (stub).
 *
 * Every verb is currently a wave-3 stub: the public surface is documented
 * in dev/active/owlette-cli/reference/command-surface.md but the api
 * wrapper over the internal command queue (`/api/admin/commands/send`)
 * has not yet shipped. Each verb exits 3 and points at the future plan.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { stubExit } from '../lib/stubExit';

const NOUN = 'process';
const REASON =
  'no public api yet — requires a public wrapper over the internal command queue (/api/admin/commands/send)';
const FUTURE_PLAN = 'dev/active/owlette-process-api/';

export function registerProcessCommands(program: Command): void {
  const proc =
    (program.commands.find((c) => c.name() === 'process') as Command | undefined) ??
    program.command('process').description('process lifecycle on machines (stub)');

  // Overwrite any earlier description so help text stays canonical
  // regardless of registration order.
  proc.description('process lifecycle on machines (stub)');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of [
    'list',
    'get',
    'create',
    'update',
    'delete',
    'kill',
    'start',
    'stop',
    'schedule',
  ] as const) {
    const existing = proc.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = proc.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- list -------------------- */

  proc
    .command('list')
    .description('list managed processes on a machine')
    .requiredOption('--machine <machineId>', 'machine id whose processes to list')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'list',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- get -------------------- */

  proc
    .command('get <id>')
    .description('print the detail record for one managed process')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'get',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- create -------------------- */

  proc
    .command('create')
    .description('register a new managed process on a machine')
    .requiredOption('--machine <machineId>', 'machine id to create the process on')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--name <name>', 'human-readable name for the process')
    .requiredOption('--exe <path>', 'absolute path to the executable')
    .requiredOption('--cwd <path>', 'working directory for the process')
    .option('--priority <priority>', 'process priority (idle|below|normal|above|high|realtime)')
    .option('--visibility <visibility>', 'window visibility (visible|hidden|minimized|maximized)')
    .action((_opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'create',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- update -------------------- */

  proc
    .command('update <id>')
    .description('update fields on an existing managed process')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .option('--name <name>', 'human-readable name for the process')
    .option('--exe <path>', 'absolute path to the executable')
    .option('--cwd <path>', 'working directory for the process')
    .option('--priority <priority>', 'process priority (idle|below|normal|above|high|realtime)')
    .option('--visibility <visibility>', 'window visibility (visible|hidden|minimized|maximized)')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'update',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- delete -------------------- */

  proc
    .command('delete <id>')
    .description('remove a managed process from a machine')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'delete',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- kill -------------------- */

  proc
    .command('kill <id>')
    .description('forcibly terminate a running managed process')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'kill',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- start -------------------- */

  proc
    .command('start <id>')
    .description('start a managed process')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'start',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- stop -------------------- */

  proc
    .command('stop <id>')
    .description('gracefully stop a managed process')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'stop',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- schedule -------------------- */

  proc
    .command('schedule <id>')
    .description('configure run-mode + schedule blocks for a managed process')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--mode <mode>', 'run mode (off|always|scheduled)')
    .option('--blocks <blocks>', 'schedule blocks as inline json or @file.json')
    .action((_id: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: NOUN,
        verb: 'schedule',
        reason: REASON,
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });
}
