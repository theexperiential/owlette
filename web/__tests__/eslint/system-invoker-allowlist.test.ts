/** @jest-environment node */

/**
 * eslint config test for `no-system-invoker-outside-allowlist`.
 *
 * Reads `web/eslint.config.mjs` as TEXT rather than running eslint — flat
 * config resolves the @next/eslint plugin chain, which is heavyweight and flaky
 * under jest. Asserts a global block restricting `@/lib/systemInvoker.server`
 * plus an override re-allowing it for `lib/hoot/**`, `lib/jobs/**`, the module
 * itself, and `__tests__/**`.
 *
 * The load-bearing gate is `scripts/check-system-invoker-callers.mjs --test`
 * (ts-ast walk); the runtime alert is covered by
 * `__tests__/lib/systemInvoker.test.ts`. Change the rule shape and this test
 * AND the ci script must move in lockstep.
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
    expect(configText).toMatch(/hoot/);
    expect(configText).toMatch(/jobs/);
    expect(configText).toMatch(/check-system-invoker-callers\.mjs/);
  });

  it('re-allows imports in the allowlist directories', () => {
    // The regex spans the override's `files` array through the following
    // `"no-restricted-imports": "off"`, so order is asserted too.
    const overrideBlock = configText.match(
      /files:\s*\[[\s\S]*?hoot[\s\S]*?jobs[\s\S]*?__tests__[\s\S]*?\][\s\S]*?"no-restricted-imports":\s*"off"/,
    );
    expect(overrideBlock).not.toBeNull();
  });

  it('mentions the wave 2.3 origin so future maintainers can find context', () => {
    expect(configText).toMatch(/wave 2\.3/i);
  });
});
