/**
 * `owlette chat new | list | send | delete | rename` — wave-3 stub group.
 *
 * Reserves the `chat` namespace for the cortex AI chat surface. `/api/cortex`
 * is currently session-authenticated only and needs api-key support before
 * these verbs can ship publicly. Each verb terminates with exit code 3 via
 * `stubExit`. Future plan: `dev/active/owlette-cortex-api/`.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { stubExit } from '../lib/stubExit';

const STUB_REASON =
  'no public api yet — /api/cortex is session-authenticated and needs api-key support before it can ship as a public command';
const FUTURE_PLAN = 'dev/active/owlette-cortex-api/';

export function registerChatCommands(program: Command): void {
  const chat =
    (program.commands.find((c) => c.name() === 'chat') as Command | undefined) ??
    program.command('chat').description('cortex ai chat (stub)');

  // Overwrite any earlier stub description so the help text stays
  // canonical regardless of registration order.
  chat.description('cortex ai chat (stub)');

  // Remove any stubs left by earlier file-load ordering.
  for (const verb of ['new', 'list', 'send', 'delete', 'rename'] as const) {
    const existing = chat.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = chat.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- new -------------------- */

  chat
    .command('new')
    .description('start a new cortex chat (stub)')
    .requiredOption('--site <siteId>', 'site id to scope the conversation to')
    .option('--machine <machineId>', 'optional machine id to scope the conversation to')
    .action((_opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        cmd,
        noun: 'chat',
        verb: 'new',
        reason: STUB_REASON,
        dashboardUrl: `${apiUrl}/cortex`,
        futurePlan: FUTURE_PLAN,
      });
    });

  /* -------------------- list -------------------- */

  chat
    .command('list')
    .description('list cortex conversations on a site (stub)')
    .requiredOption('--site <siteId>', 'site id to list conversations for')
    .action((_opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        cmd,
        noun: 'chat',
        verb: 'list',
        reason: STUB_REASON,
        dashboardUrl: `${apiUrl}/cortex`,
        futurePlan: FUTURE_PLAN,
      });
    });

  /* -------------------- send -------------------- */

  chat
    .command('send <conversationId> <message>')
    .description('send a message to a cortex conversation (stub)')
    .action((_conversationId: string, _message: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        cmd,
        noun: 'chat',
        verb: 'send',
        reason: STUB_REASON,
        dashboardUrl: `${apiUrl}/cortex`,
        futurePlan: FUTURE_PLAN,
      });
    });

  /* -------------------- delete -------------------- */

  chat
    .command('delete <conversationId>')
    .description('delete a cortex conversation (stub)')
    .action((_conversationId: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        cmd,
        noun: 'chat',
        verb: 'delete',
        reason: STUB_REASON,
        dashboardUrl: `${apiUrl}/cortex`,
        futurePlan: FUTURE_PLAN,
      });
    });

  /* -------------------- rename -------------------- */

  chat
    .command('rename <conversationId> <title>')
    .description('rename a cortex conversation (stub)')
    .action((_conversationId: string, _title: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        cmd,
        noun: 'chat',
        verb: 'rename',
        reason: STUB_REASON,
        dashboardUrl: `${apiUrl}/cortex`,
        futurePlan: FUTURE_PLAN,
      });
    });
}
