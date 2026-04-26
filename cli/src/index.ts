#!/usr/bin/env node
/**
 * owlette CLI entrypoint — builds the commander program, wires sub-
 * commands, and dispatches argv. The `./bin/owlette` launcher exec's
 * `dist/index.js` (after `npm run build`) or `ts-node src/index.ts`
 * during development. The `./bin/roost` wrapper prints a deprecation
 * notice and forwards to this same entrypoint.
 */

import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth';
import { registerPushCommand } from './commands/push';
import { registerRoostInspectCommands } from './commands/roost';
import { registerRollbackCommand } from './commands/rollback';
import { registerRoostDeployCommand } from './commands/roost-deploy';
import { registerDeployCommands } from './commands/deploy';
import { registerKeyCommands } from './commands/key';
import { registerListenCommand } from './commands/listen';
import { registerTriggerCommand } from './commands/trigger';
import { registerSiteCommands } from './commands/site';
import { registerQuotaCommands } from './commands/quota';
import { registerMachineCommands } from './commands/machine';
import { registerAuditLogCommands } from './commands/audit-log';
import { registerWhoamiCommand } from './commands/whoami';
import { registerVersionCommand } from './commands/version';
import { registerChatCommands } from './commands/chat';
import { registerUserCommands } from './commands/user';
import { registerProcessCommands } from './commands/process';
import { registerInstallerCommands } from './commands/installer';

const PROGRAM_NAME = 'owlette';
const VERSION = '0.2.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description('owlette — cli for the owlette api')
    .version(VERSION)
    .option('--profile <name>', 'named profile from ~/.config/owlette/config.toml')
    .option('--json', 'emit structured JSON instead of ascii tables on stdout');

  // top-level: auth (login / status / logout)
  registerAuthCommands(program);

  // top-level: whoami + version (bare verbs that ask about cli/server state)
  registerWhoamiCommand(program);
  registerVersionCommand(program);

  // noun: roost — push / list / get / diff / versions / deploy
  program.command('roost').description('manage roosts + versions');
  registerPushCommand(program);
  registerRoostInspectCommands(program);
  registerRoostDeployCommand(program);

  // a-tier nouns (wave 2): site / quota / machine / audit-log
  registerSiteCommands(program);
  registerQuotaCommands(program);
  registerMachineCommands(program);
  registerAuditLogCommands(program);

  // c-tier stubs (wave 3): chat / user / deploy / process / installer.
  // top-level `deploy` is the classic-installer stub group; the real
  // content-addressed deploy lives at `roost deploy` above.
  registerChatCommands(program);
  registerUserCommands(program);
  registerDeployCommands(program);
  registerProcessCommands(program);
  registerInstallerCommands(program);

  // top-level verbs (kept top-level for muscle memory; may move under
  // nouns in a future restructure)
  registerRollbackCommand(program);
  registerKeyCommands(program);
  registerListenCommand(program);
  registerTriggerCommand(program);

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv as string[]);
}

// Only run main() when invoked as a script (not when imported for tests).
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`[owlette] ${(err as Error).message}`);
    process.exit(1);
  });
}
