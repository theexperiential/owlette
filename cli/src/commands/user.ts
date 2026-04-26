/**
 * `owlette user list | get | promote | demote | assign-sites | remove-sites | delete`.
 *
 * Wave-3 stub: no `/api/users` endpoints exist yet. Every verb exits with
 * code 3 via the shared `stubExit` helper and points operators at the
 * superadmin dashboard. Future plan: `dev/active/owlette-users-api/`.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { stubExit } from '../lib/stubExit';

const FUTURE_PLAN = 'dev/active/owlette-users-api/';
const REASON = 'no public api yet — /api/users endpoints have not been built';

export function registerUserCommands(program: Command): void {
  const user =
    (program.commands.find((c) => c.name() === 'user') as Command | undefined) ??
    program.command('user').description('platform user management (stub — superadmin)');

  // Overwrite any earlier stub description so help text stays canonical
  // regardless of registration order.
  user.description('platform user management (stub — superadmin)');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of [
    'list',
    'get',
    'promote',
    'demote',
    'assign-sites',
    'remove-sites',
    'delete',
  ] as const) {
    const existing = user.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = user.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- list -------------------- */

  user
    .command('list')
    .description('list platform users (stub — superadmin)')
    .action((_opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'list',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- get -------------------- */

  user
    .command('get <uid>')
    .description('print the detail record for one platform user (stub — superadmin)')
    .action((_uid: string, _opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'get',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- promote -------------------- */

  user
    .command('promote <uid>')
    .description('promote a user to admin or superadmin (stub — superadmin)')
    .requiredOption('--role <role>', 'target role: admin | superadmin')
    .action((_uid: string, _opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'promote',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- demote -------------------- */

  user
    .command('demote <uid>')
    .description('demote a user back to the default role (stub — superadmin)')
    .action((_uid: string, _opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'demote',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- assign-sites -------------------- */

  user
    .command('assign-sites <uid>')
    .description('grant a user access to one or more sites (stub — superadmin)')
    .requiredOption('--sites <csv>', 'comma-separated list of site ids to assign')
    .action((_uid: string, _opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'assign-sites',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- remove-sites -------------------- */

  user
    .command('remove-sites <uid>')
    .description('revoke a user\'s access to one or more sites (stub — superadmin)')
    .requiredOption('--sites <csv>', 'comma-separated list of site ids to remove')
    .action((_uid: string, _opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'remove-sites',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });

  /* -------------------- delete -------------------- */

  user
    .command('delete <uid>')
    .description('delete a platform user (stub — superadmin)')
    .option('--yes', 'skip the interactive confirmation prompt')
    .action((_uid: string, _opts, cmd) => {
      stubExit({
        noun: 'user',
        verb: 'delete',
        reason: REASON,
        dashboardUrl: dashboardUrl(cmd),
        futurePlan: FUTURE_PLAN,
        cmd,
      });
    });
}

/* --------------------------------------------------------------------- */
/*  util                                                                 */
/* --------------------------------------------------------------------- */

function dashboardUrl(cmd: Command): string {
  const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  return `${apiUrl}/superadmin`;
}
