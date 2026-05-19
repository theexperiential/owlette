/** @jest-environment node */

/**
 * eslint config test for the `no-system-invoker-outside-allowlist`
 * policy added in security-boundary-migration wave 2.3.
 *
 * Strategy: instead of spinning up the eslint runtime (which is
 * heavyweight + flaky in jest because eslint flat config resolves the
 * @next/eslint plugin chain), we read `web/eslint.config.mjs` as text
 * and assert the rule shape is present in two places:
 *
 *   1. A global block restricts `@/lib/systemInvoker.server` (and
 *      relative-path equivalents).
 *   2. An override block re-allows the import inside the allowlist:
 *      `lib/cortex/**`, `lib/jobs/**`, `lib/systemInvoker.server.ts`
 *      (the file itself, for re-export-style usage), and `__tests__/**`.
 *
 * The companion runtime + ci checks own the deeper end-to-end behavior:
 *   - `web/__tests__/lib/systemInvoker.test.ts` (the runtime alert
 *     `UNEXPECTED_SYSTEM_INVOKER_CALLER` is exercised against fake
 *     stack traces).
 *   - `scripts/check-system-invoker-callers.mjs --test` (the ci
 *     scanner re-implements the allowlist on top of a typescript ast
 *     walk — that's the load-bearing gate; this test just ensures the
 *     editor-time eslint rule stays consistent with it).
 *
 * If the rule shape changes, update this test AND the ci script in
 * lockstep so both gates stay in sync.
 */

import { readFileSync } from 'fs';
import path from 'path';

const ESLINT_CONFIG_PATH = path.join(__dirname, '..', '..', 'eslint.config.mjs');

describe('eslint config — no-system-invoker-outside-allowlist', () => {
  let configText: string;

  beforeAll(() => {
    configText = readFileSync(ESLINT_CONFIG_PATH, 'utf8');
  });

  it('declares no-restricted-imports for systemInvoker.server (alias form)', () => {
    expect(configText).toMatch(/no-restricted-imports/);
    expect(configText).toMatch(/@\/lib\/systemInvoker\.server/);
  });

  it('blocks the relative-path glob form too', () => {
    expect(configText).toMatch(/\*\*\/lib\/systemInvoker\.server/);
  });

  it('explains the allowlist in the rule message', () => {
    expect(configText).toMatch(/cortex/);
    expect(configText).toMatch(/jobs/);
    expect(configText).toMatch(/check-system-invoker-callers\.mjs/);
  });

  it('re-allows imports in the allowlist directories', () => {
    // Confirm cortex / jobs / __tests__ paths each appear in an override block
    // that turns the rule off. Order is asserted by the regex spanning across
    // the override block's `files` array and the `"no-restricted-imports": "off"`
    // entry that follows.
    const overrideBlock = configText.match(
      /files:\s*\[[\s\S]*?cortex[\s\S]*?jobs[\s\S]*?__tests__[\s\S]*?\][\s\S]*?"no-restricted-imports":\s*"off"/,
    );
    expect(overrideBlock).not.toBeNull();
  });

  it('mentions the wave 2.3 origin so future maintainers can find context', () => {
    expect(configText).toMatch(/wave 2\.3/i);
  });
});
