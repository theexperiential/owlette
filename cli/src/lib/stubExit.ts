/**
 * Shared helper for "stub" cli commands — nouns whose surface area is
 * documented but whose public api is not yet shipped. Calling a stub
 * always terminates the process with exit code 3 (reserved for stubs,
 * distinct from generic errors (1) and usage errors (2)).
 *
 * Output contract:
 *   - `--json` mode: a single canonical envelope on stdout
 *       { ok: false, stub: true, noun, reason, dashboard_url, future_plan }
 *     (snake_case keys match the documented json envelope schema in
 *     docs/cli/overview.md#json-envelope-schema)
 *   - human mode: a multi-line block on stderr explaining the stub,
 *     pointing at the dashboard, and naming the future plan doc.
 *
 * Keeping this in one place means every stub command stays a 3-5 line
 * shim that just declares its noun + reason and delegates here.
 */

import type { Command } from 'commander';
import { errLine, isJson, printJson } from './output';

export interface StubExitArgs {
  noun: string;
  reason: string;
  dashboardUrl: string;
  futurePlan: string;
  /** optional commander instance — used to detect `--json`. */
  cmd?: Command;
  /** optional verb (e.g. `list`, `new`) — included in the stderr header. */
  verb?: string;
}

export function stubExit(args: StubExitArgs): never {
  const { noun, reason, dashboardUrl, futurePlan, cmd, verb } = args;

  if (cmd && isJson(cmd)) {
    printJson({
      ok: false,
      stub: true,
      noun,
      reason,
      dashboard_url: dashboardUrl,
      future_plan: futurePlan,
    });
    process.exit(3);
  }

  const header = verb ? `\`${noun} ${verb}\`` : `\`${noun}\``;
  errLine(`owlette: ${header} is a stub — ${reason}.`);
  errLine(`  reason       : ${reason}`);
  errLine(`  dashboard    : ${dashboardUrl}`);
  errLine(`  future plan  : ${futurePlan}`);
  process.exit(3);
}
