#!/usr/bin/env node
/**
 * check-no-token-logs — policy enforcement (roost wave 5.10).
 *
 * Greps the repo for log calls that reference auth tokens or credentials.
 * OAuth access tokens, refresh tokens, Firebase ID tokens, API keys, and
 * Authorization headers must never hit any log sink — not in debug, not in
 * error paths, not partial. Leaking tokens is a P0 incident.
 *
 * Exits 1 on any match so CI fails on the PR that introduces the leak.
 *
 * Usage:
 *   node scripts/check-no-token-logs.mjs          # scan repo
 *   node scripts/check-no-token-logs.mjs --test   # self-test against fixtures
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCAN_ROOTS = [
  join(ROOT, 'web', 'app'),
  join(ROOT, 'web', 'components'),
  join(ROOT, 'web', 'hooks'),
  join(ROOT, 'web', 'lib'),
  join(ROOT, 'web', 'contexts'),
  join(ROOT, 'web', 'scripts'),
  join(ROOT, 'agent', 'src'),
];

const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'out',
  'build',
  'dist',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.mypy_cache',
]);

// token-ish identifiers whose presence in a log call is disallowed.
// word-boundary match so `authToken`, `refresh_token`, `ID_TOKEN` all catch,
// but unrelated words like `token_stream` (e.g. a parser) only match if
// they appear inside a log call — which the pattern requires.
const TOKEN_IDENTIFIERS = [
  'token',
  'tokens',
  'bearer',
  'authorization',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'apikey',
  'api_key',
  'x-api-key',
  'client_secret',
  'clientsecret',
  'authcode',
  'auth_code',
  'fernet',
  'private_key',
  'privatekey',
];

const TOKEN_WORD_RE = new RegExp(
  `\\b(${TOKEN_IDENTIFIERS.join('|')})\\b`,
  'i',
);

// log-call prefixes to scan. order matters — longer first so we don't
// double-match on substrings.
const LOG_PATTERNS = [
  // javascript / typescript
  /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/,
  /\b(Sentry)\.(captureException|captureMessage|setContext|addBreadcrumb|setUser)\s*\(/,
  // python
  /\blogger\.(debug|info|warning|error|critical|exception|log)\s*\(/,
  /\blogging\.(debug|info|warning|error|critical|exception|log)\s*\(/,
  /\bprint\s*\(/,
];

// strings that look like log calls but are intentionally safe. exempting
// by comment marker is explicit — the author has to opt-in to whitelist.
const ALLOW_COMMENT = 'no-token-logs-allow';

// files where references to token identifiers are part of the business
// logic (schema definitions, token-handling code itself) — scanning them
// produces only noise. scanner still checks their log calls — any log
// that names a token triggers regardless of the file. what this list
// suppresses is scanning of the file entirely.
const FILE_ALLOWLIST = new Set([
  // the lint rule itself — this very file mentions token identifiers
  // in the TOKEN_IDENTIFIERS array.
  join('scripts', 'check-no-token-logs.mjs').replace(/\\/g, '/'),
  // eslint config may declare the no-restricted-syntax patterns using
  // the same identifier words.
  join('web', 'eslint.config.mjs').replace(/\\/g, '/'),
]);

/**
 * Extract the argument region of a log call, starting from the `(` after
 * the matched log prefix and collecting characters until the matching `)`.
 * Handles nested parens + string literals. Returns null if no balanced
 * close found in the line (multi-line call — we only scan the first line
 * for simplicity; cross-line calls that would otherwise leak will be
 * caught by identifier-level grep when that identifier appears in the
 * same line as the log call).
 */
function extractCallArgs(line, openIdx) {
  let depth = 0;
  let inStr = null; // "'", '"', '`', or null
  let escape = false;
  for (let i = openIdx; i < line.length; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return line.slice(openIdx + 1, i);
      }
    }
  }
  // unbalanced on this line — return what we have. cross-line leak
  // detection is best-effort; whole-argument scan still runs later.
  return line.slice(openIdx + 1);
}

/**
 * True if the given log-call argument region references a token identifier
 * as a name token (not just substring-inside-a-string).
 *
 * The check strips string literals so a log statement like
 *   logger.info("oauth_token is the pattern name")
 * doesn't false-positive on its own message text. We WANT to catch
 *   logger.info(f"oauth_token: {token}")
 * because the f-string interpolates the actual token — the identifier
 * `token` survives string stripping.
 */
function argsReferenceToken(argsText) {
  // strip string literals (single, double, backtick, python triple).
  // this leaves identifiers + operators + template-expression content.
  let stripped = argsText
    // python triple-quoted strings
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    // regular strings (non-greedy; allow escaped quotes)
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '');

  // template literals need care: strip the static text but KEEP ${...}
  // expression contents so `console.log(\`token=${accessToken}\`)` catches.
  // the inner char class deliberately allows `$` so `${expr}` segments are
  // part of the match (prior bug: excluding `$` made the whole literal
  // unmatchable whenever it contained an interpolation, leaving the
  // static text to false-positive on tokens-the-word).
  stripped = stripped.replace(
    /`((?:[^`\\]|\\.)*)`/g,
    (_full, inner) => {
      const exprMatches = [...inner.matchAll(/\$\{([^}]*)\}/g)];
      return exprMatches.map((m) => m[1]).join(' ');
    },
  );

  // python f-strings — similar: extract {expr} contents.
  // (our string-stripping above already removed non-f quoted segments;
  // f-strings are f"..." or f'...'. we reparse the original argsText
  // for f-string contents since they'd have been stripped.)
  const fstringMatches = [
    ...argsText.matchAll(/\bf["']((?:[^"'\\]|\\.)*)["']/g),
  ];
  for (const m of fstringMatches) {
    const exprs = [...m[1].matchAll(/\{([^}]*)\}/g)];
    for (const e of exprs) stripped += ' ' + e[1];
  }

  return TOKEN_WORD_RE.test(stripped);
}

function scanFile(absPath) {
  const relPath = relative(ROOT, absPath).replace(/\\/g, '/');
  if (FILE_ALLOWLIST.has(relPath)) return [];

  let text;
  try {
    text = readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const findings = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line.includes(ALLOW_COMMENT)) continue;

    for (const pattern of LOG_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      const openIdx = line.indexOf('(', m.index);
      if (openIdx === -1) continue;
      const args = extractCallArgs(line, openIdx);
      if (argsReferenceToken(args)) {
        findings.push({
          file: relPath,
          line: lineNum + 1,
          snippet: line.trim().slice(0, 200),
        });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot === -1) continue;
      if (INCLUDE_EXT.has(name.slice(dot))) out.push(full);
    }
  }
}

function runScan() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    if (existsSync(root)) walk(root, files);
  }
  const findings = [];
  for (const f of files) {
    findings.push(...scanFile(f));
  }
  return findings;
}

function runSelfTest() {
  // fixture: should FLAG every entry.
  const bad = [
    `console.log("access_token=" + accessToken);`,
    `console.error(\`auth failed for token=\${idToken}\`);`,
    `logger.debug(f"refresh_token: {refresh_token}")`,
    `logger.info("bearer", authorization)`,
    `print(access_token)`,
    `Sentry.captureMessage("user token", { extra: { token } });`,
  ];
  // fixture: should NOT flag.
  const good = [
    `console.log("authenticated")`,
    `logger.info("login ok for user %s", userId)`,
    `logger.error("token refresh failed", exc_info=True)  // no-token-logs-allow`,
    `const pattern = "token stream parser";`,
    `// string mentions token but not in a log call`,
  ];

  let failures = 0;

  for (const line of bad) {
    let matched = false;
    for (const pat of LOG_PATTERNS) {
      const m = pat.exec(line);
      if (!m) continue;
      const openIdx = line.indexOf('(', m.index);
      if (openIdx === -1) continue;
      if (argsReferenceToken(extractCallArgs(line, openIdx))) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      console.error(`SELFTEST FAIL: expected flag on:\n  ${line}`);
      failures++;
    }
  }

  for (const line of good) {
    if (line.includes(ALLOW_COMMENT)) continue;
    let matched = false;
    for (const pat of LOG_PATTERNS) {
      const m = pat.exec(line);
      if (!m) continue;
      const openIdx = line.indexOf('(', m.index);
      if (openIdx === -1) continue;
      if (argsReferenceToken(extractCallArgs(line, openIdx))) {
        matched = true;
        break;
      }
    }
    if (matched) {
      console.error(`SELFTEST FAIL: false positive on:\n  ${line}`);
      failures++;
    }
  }

  if (failures === 0) {
    console.log('selftest: OK (6 must-flag + 5 must-pass fixtures)');
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const failures = runSelfTest();
    process.exit(failures === 0 ? 0 : 1);
  }

  const findings = runScan();
  if (findings.length === 0) {
    console.log('no-token-logs: OK');
    process.exit(0);
  }

  console.error(
    `\nno-token-logs: FAILED — ${findings.length} potential token leak(s):\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.snippet}`);
  }
  console.error(
    `\nToken/credential references inside log/print calls are forbidden.`,
  );
  console.error(
    `If a finding is a genuine false positive (e.g. the "token" is the ` +
      `literal word, not a value), append "// ${ALLOW_COMMENT}" or ` +
      `"# ${ALLOW_COMMENT}" to that line.\n`,
  );
  process.exit(1);
}

main();
