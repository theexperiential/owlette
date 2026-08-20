#!/usr/bin/env node
/**
 * check-system-invoker-callers — CI gate: `web/lib/systemInvoker.server` may only
 * be imported from `web/lib/hoot/**`, `web/lib/jobs/**`, `web/__tests__/**`, or
 * itself. Anywhere else, a code path just took system-actor authority that belongs
 * to the `authorizedHandler` wrapper or a feature helper.
 *
 * The `no-restricted-imports` eslint rule is the editor-time twin; this runs even
 * when eslint is bypassed or stale. Exits 1 on any violation.
 *
 *   node scripts/check-system-invoker-callers.mjs           # scan repo
 *   node scripts/check-system-invoker-callers.mjs --test    # self-test
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');

// `typescript` lives in web/node_modules and the repo root has no package.json,
// so scope createRequire at web to resolve from any cwd.
const requireFromWeb = createRequire(pathToFileURL(join(WEB_DIR, 'package.json')).href);
let ts;
try {
  ts = requireFromWeb('typescript');
} catch (err) {
  process.stderr.write('[check-system-invoker-callers] failed to load typescript from web/node_modules.\n');
  process.stderr.write('  run `cd web && npm install` first.\n');
  process.stderr.write(`  underlying error: ${err.message}\n`);
  process.exit(2);
}

const SCAN_ROOTS = [
  join(ROOT, 'web'),
  join(ROOT, 'scripts'),
];

const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'out',
  'build',
  'dist',
  'coverage',
  '.firebase-config',
]);

const MODULE_NAME = 'systemInvoker.server';
const ABSOLUTE_ALIAS = '@/lib/systemInvoker.server';

// Matched against the POSIX repo-relative path of the importer; any match passes.
const ALLOWED_PATTERNS = [
  /^web\/lib\/hoot\//,
  /^web\/lib\/jobs\//,
  /^web\/__tests__\//,
  /^web\/lib\/systemInvoker\.server\.ts$/,
];

function* walk(dir) {
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
      yield* walk(full);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot) : '';
      if (INCLUDE_EXT.has(ext)) {
        yield full;
      }
    }
  }
}

function toPosixRelative(absPath) {
  return relative(ROOT, absPath).split(sep).join(posix.sep);
}

/**
 * True when `specifier` resolves (extension elision included) to
 * `web/lib/systemInvoker.server`, via the `@/` alias or a relative path.
 */
function isSystemInvokerImport(specifier, importerPosixPath) {
  if (!specifier) return false;
  if (specifier === ABSOLUTE_ALIAS) return true;
  if (specifier === `${ABSOLUTE_ALIAS}.ts`) return true;

  // Un-aliased specifier naming the module: only reachable via a re-export, so
  // inspect it rather than trusting it.
  if (specifier.endsWith(`/${MODULE_NAME}`) || specifier.endsWith(`/${MODULE_NAME}.ts`)) {
    if (specifier.startsWith('.')) {
      const importerDir = dirname(importerPosixPath);
      const resolved = posix.normalize(posix.join(importerDir, specifier));
      const trimmed = resolved.replace(/\.ts$/, '');
      return trimmed === 'web/lib/systemInvoker.server';
    }
    return true; // conservative: eslint flags the same shape
  }
  return false;
}

/**
 * Every import/require specifier in `source`. Uses the typescript parser so
 * comments, dynamic imports and re-exports are all handled.
 */
function extractImports(source, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    /*scriptKind*/ inferScriptKind(fileName),
  );
  const specifiers = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const ms = node.moduleSpecifier;
      if (ms && ts.isStringLiteral(ms)) specifiers.push(ms.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      // dynamic import('...') / require('...')
      const callee = node.expression;
      const isImportKeyword = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isImportKeyword || isRequire) && node.arguments.length === 1) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) specifiers.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specifiers;
}

function inferScriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

function isAllowedImporter(posixPath) {
  return ALLOWED_PATTERNS.some((re) => re.test(posixPath));
}

function scan(roots) {
  const violations = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const posixRel = toPosixRelative(file);
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!source.includes(MODULE_NAME)) continue; // cheap guard

      let imports;
      try {
        imports = extractImports(source, file);
      } catch (err) {
        // Non-fatal: a file that won't parse fails ts/eslint anyway.
        process.stderr.write(`[check-system-invoker-callers] parse failure: ${posixRel}: ${err.message}\n`);
        continue;
      }

      for (const spec of imports) {
        if (isSystemInvokerImport(spec, posixRel)) {
          if (!isAllowedImporter(posixRel)) {
            violations.push({ file: posixRel, specifier: spec });
          }
        }
      }
    }
  }
  return violations;
}

function runMain() {
  const violations = scan(SCAN_ROOTS);
  if (violations.length === 0) {
    process.stdout.write('check-system-invoker-callers: ok (0 violations)\n');
    process.exit(0);
  }
  process.stderr.write(
    `check-system-invoker-callers: ${violations.length} violation(s)\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file} imports "${v.specifier}"\n`);
  }
  process.stderr.write(
    '\nsystemInvoker.server may only be imported from web/lib/hoot/**, web/lib/jobs/**, web/__tests__/**.\n',
  );
  process.exit(1);
}

function runSelfTest() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'sysinv-test-'));
  try {
    const okDir = join(tempRoot, 'web', 'lib', 'hoot');
    const badDir = join(tempRoot, 'web', 'app', 'api', 'foo');
    mkdirP(okDir);
    mkdirP(badDir);

    writeFileSync(
      join(okDir, 'allowed.ts'),
      `import { invokeAsSystem } from '@/lib/systemInvoker.server';\nexport const _u = invokeAsSystem;\n`,
      'utf8',
    );
    writeFileSync(
      join(badDir, 'route.ts'),
      `import { invokeAsSystem } from '@/lib/systemInvoker.server';\nexport const _u = invokeAsSystem;\n`,
      'utf8',
    );

    // Same logic as scan(), but rooted at tempRoot.
    const violations = [];
    for (const file of walk(join(tempRoot, 'web'))) {
      const rel = relative(tempRoot, file).split(sep).join(posix.sep);
      const source = readFileSync(file, 'utf8');
      if (!source.includes(MODULE_NAME)) continue;
      const imports = extractImports(source, file);
      for (const spec of imports) {
        if (isSystemInvokerImport(spec, rel)) {
          if (!isAllowedImporter(rel)) {
            violations.push({ file: rel, specifier: spec });
          }
        }
      }
    }
    const expected = [{ file: 'web/app/api/foo/route.ts', specifier: '@/lib/systemInvoker.server' }];
    const actual = JSON.stringify(violations);
    if (actual !== JSON.stringify(expected)) {
      process.stderr.write(`self-test FAILED. expected ${JSON.stringify(expected)}, got ${actual}\n`);
      process.exit(1);
    }
    process.stdout.write('check-system-invoker-callers: self-test ok\n');
    process.exit(0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function mkdirP(dir) {
  mkdirSync(dir, { recursive: true });
}

if (process.argv.includes('--test')) {
  runSelfTest();
} else {
  runMain();
}
