#!/usr/bin/env node
/**
 * roost CLI entrypoint — builds the commander program, wires sub-
 * commands, and dispatches argv. The `./bin/roost` launcher exec's
 * `dist/index.js` (after `npm run build`) or `ts-node src/index.ts`
 * during development.
 *
 * Sub-commands are stubbed in this file and will be filled in during
 * tasks 4.2 (auth), 4.3 (push), 4.4 (inspect), 4.5 (rollback), 4.6
 * (deploy), 4.7 (key), 4.8 (listen), 4.9 (trigger).
 */

import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth';
import { registerPushCommand } from './commands/push';
import { registerRoostInspectCommands } from './commands/roost';
import { registerRollbackCommand } from './commands/rollback';
import { registerDeployCommand } from './commands/deploy';
import { registerKeyCommands } from './commands/key';
import { registerListenCommand } from './commands/listen';
import { registerTriggerCommand } from './commands/trigger';

const PROGRAM_NAME = 'roost';
const VERSION = '0.1.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description('roost — cli for the owlette public api (v0.1 scaffold)')
    .version(VERSION)
    .option('--profile <name>', 'named profile from ~/.config/roost/config.toml')
    .option('--json', 'emit structured JSON instead of ascii tables on stdout');

  // noun: auth — wave 4.2 (login / status / logout)
  registerAuthCommands(program);

  // noun: roost — wave 4.3 / 4.4 / 4.5
  program.command('roost').description('manage roosts + manifests');

  registerPushCommand(program); // wave 4.3
  registerRoostInspectCommands(program); // wave 4.4 — list / get / diff

  registerRollbackCommand(program); // wave 4.5

  registerDeployCommand(program); // wave 4.6

  registerKeyCommands(program); // wave 4.7 — create / list / rotate / revoke

  registerListenCommand(program); // wave 4.8

  registerTriggerCommand(program); // wave 4.9

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv as string[]);
}

// Only run main() when invoked as a script (not when imported for tests).
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`[roost] ${(err as Error).message}`);
    process.exit(1);
  });
}
