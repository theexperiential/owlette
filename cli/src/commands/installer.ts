/**
 * `owlette installer list | upload | set-latest | delete` — stub commands.
 *
 * Agent installer binary management lives behind `/api/admin/installer/*`,
 * which is admin-session-gated today. these verbs reserve the surface so
 * the help text is canonical, but every action terminates with exit 3.
 * future plan: `dev/active/owlette-installer-api/`.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { stubExit } from '../lib/stubExit';

export function registerInstallerCommands(program: Command): void {
  const installer =
    (program.commands.find((c) => c.name() === 'installer') as Command | undefined) ??
    program
      .command('installer')
      .description('agent installer binary management (stub — superadmin)');

  // Overwrite any earlier description so the help text stays canonical
  // regardless of registration order.
  installer.description('agent installer binary management (stub — superadmin)');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['list', 'upload', 'set-latest', 'delete'] as const) {
    const existing = installer.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = installer.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  const reason =
    'no public api yet — /api/admin/installer/* is admin-session-gated and needs api-key support before it can ship as a public command';
  const futurePlan = 'dev/active/owlette-installer-api/';

  /* -------------------- list -------------------- */

  installer
    .command('list')
    .description('list uploaded installer versions (stub — superadmin)')
    .action((_opts, cmd: Command) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: 'installer',
        verb: 'list',
        reason,
        dashboardUrl: `${apiUrl}/superadmin`,
        futurePlan,
        cmd,
      });
    });

  /* -------------------- upload -------------------- */

  installer
    .command('upload <file>')
    .description('upload a new installer binary (stub — superadmin)')
    .requiredOption('--version <semver>', 'semver of the installer being uploaded')
    .requiredOption('--notes <text>', 'release notes shown on the dashboard')
    .option('--set-latest', 'mark this version as the latest after upload')
    .action((_file: string, _opts, cmd: Command) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: 'installer',
        verb: 'upload',
        reason,
        dashboardUrl: `${apiUrl}/superadmin`,
        futurePlan,
        cmd,
      });
    });

  /* -------------------- set-latest -------------------- */

  installer
    .command('set-latest <version>')
    .description('mark an uploaded version as the latest installer (stub — superadmin)')
    .action((_version: string, _opts, cmd: Command) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: 'installer',
        verb: 'set-latest',
        reason,
        dashboardUrl: `${apiUrl}/superadmin`,
        futurePlan,
        cmd,
      });
    });

  /* -------------------- delete -------------------- */

  installer
    .command('delete <version>')
    .description('delete an uploaded installer version (stub — superadmin)')
    .action((_version: string, _opts, cmd: Command) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: 'installer',
        verb: 'delete',
        reason,
        dashboardUrl: `${apiUrl}/superadmin`,
        futurePlan,
        cmd,
      });
    });
}
