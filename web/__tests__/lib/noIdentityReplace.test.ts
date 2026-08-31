/**
 * Guard against `.replace(/X/g, 'X')` — a call that matches something and
 * substitutes the identical thing, so it does nothing at all.
 *
 * This is not hypothetical. Two shipped in this repo:
 *
 *   web/lib/firebase-admin.ts        `.replace(/\n/g, '\n')` where the intent
 *                                    was `/\\n/g` — converting the literal
 *                                    two-character `\n` sequences that an env
 *                                    var carries into real newlines. As an
 *                                    identity it silently stopped converting,
 *                                    which would break Firebase Admin cert
 *                                    parsing for any deployment whose
 *                                    FIREBASE_PRIVATE_KEY is stored escaped.
 *                                    Introduced by a backslash lost in an
 *                                    editing pass; CodeQL caught it as
 *                                    js/identity-replacement.
 *
 *   web/components/ProjectDistributionDialog.tsx
 *                                    `.replace(/\\\\/g, '\\\\')` where the
 *                                    intent was to double a single backslash
 *                                    so a Windows path renders as valid JSON
 *                                    in a copyable config snippet.
 *
 * Both are invisible on inspection — the code reads as though it transforms
 * something. A cheap textual scan catches the whole class.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `.replace(/BODY/FLAGS, 'REPL')` with a single-quoted literal replacement. */
const REPLACE_CALL = /\.replace\(\s*\/((?:[^/\\]|\\.)+)\/([gimsuy]*)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g;

const SEARCH_ROOTS = ['app', 'components', 'contexts', 'hooks', 'lib', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-e2e', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * True when the pattern body and the replacement are the same literal text.
 *
 * Compares source text rather than evaluating: `/\n/g` and `'\n'` both read as
 * the two characters `\` `n` here, which is exactly the equivalence that makes
 * the call a no-op. Regex-only constructs (`+`, `[...]`, anchors) never match a
 * plain replacement string, so they fall out on their own.
 */
function isIdentityReplace(patternBody: string, replacement: string): boolean {
  return patternBody === replacement;
}

describe('no identity .replace() calls', () => {
  const files = SEARCH_ROOTS.flatMap((r) => walk(path.join(process.cwd(), r)));

  it('scans a meaningful number of files', () => {
    // Cheap canary: a broken walk would make the real assertion vacuously pass.
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds none', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(REPLACE_CALL)) {
        const [full, body, , replacement] = m;
        if (!isIdentityReplace(body, replacement)) continue;
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(
          `${path.relative(process.cwd(), file)}:${line} ${full.trim()}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects the two that actually shipped (negative control)', () => {
    // Without this, a broken regex would make the scan above pass silently.
    const firebaseAdminBug = String.raw`\n`;
    const dialogBug = String.raw`\\\\`;

    expect(isIdentityReplace(firebaseAdminBug, firebaseAdminBug)).toBe(true);
    expect(isIdentityReplace(dialogBug, dialogBug)).toBe(true);
    // And the corrected forms are not identities.
    expect(isIdentityReplace(String.raw`\\n`, String.raw`\n`)).toBe(false);
    expect(isIdentityReplace(String.raw`\\`, String.raw`\\\\`)).toBe(false);
  });
});
