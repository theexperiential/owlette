#!/usr/bin/env node
/**
 * check-lockdown-ready - security-boundary-migration wave 6.2 gate.
 *
 * Runs the pre-lockdown checks that must all pass at the same git sha before
 * wave 7 can tighten Firestore rules. The script always writes a markdown
 * report and exits non-zero when any gate fails or is missing.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const FUNCTIONS_DIR = join(ROOT, 'functions');
const REPORT_PATH = join(
  ROOT,
  'dev',
  'active',
  'security-boundary-migration',
  'reference',
  'lockdown-readiness.md',
);
const DENIAL_TEST_PATH = join(WEB_DIR, '__tests__', 'rules', 'denials.test.ts');
const CALIBRATION_PATH = join(
  ROOT,
  'dev',
  'active',
  'security-boundary-migration',
  'reference',
  'rate-limit-calibration.md',
);

const MAX_OUTPUT_CHARS = 6000;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const FIREBASE = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';

const args = new Set(process.argv.slice(2));
const writeReport = !args.has('--no-report');
const failFast = args.has('--fail-fast');

function run(command, options = {}) {
  const startedAt = new Date().toISOString();
  const parts = Array.isArray(command) ? command : [command];
  const spawn = normalizeSpawn(parts);
  const result = spawnSync(spawn.file, spawn.args, {
    cwd: options.cwd ?? ROOT,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const finishedAt = new Date().toISOString();
  return {
    command: formatCommand(parts),
    cwd: relative(ROOT, options.cwd ?? ROOT) || '.',
    startedAt,
    finishedAt,
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : null,
  };
}

function normalizeSpawn(parts) {
  const file = String(parts[0]);
  if (process.platform === 'win32' && /\.cmd$/i.test(file)) {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', parts.map(quoteCmdArg).join(' ')],
    };
  }
  return { file, args: parts.slice(1).map(String) };
}

function quoteCmdArg(part) {
  const value = String(part);
  return /[\s&()^%!<>|"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommand(parts) {
  return parts
    .map((part) => {
      const value = String(part);
      return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
    })
    .join(' ');
}

function gitValue(command, fallback = 'unknown') {
  const result = run(command);
  if (result.exitCode !== 0) return fallback;
  return result.stdout.trim() || fallback;
}

function truncateOutput(text) {
  if (!text) return '';
  if (text.length <= MAX_OUTPUT_CHARS) return text.trim();
  const headChars = Math.floor(MAX_OUTPUT_CHARS * 0.35);
  const tailChars = MAX_OUTPUT_CHARS - headChars;
  return `${text.slice(0, headChars).trim()}\n... [truncated] ...\n${text.slice(-tailChars).trim()}`;
}

function commandCheck({ id, title, command, cwd, evaluate }) {
  const commandResult = run(command, { cwd });
  const evaluation = evaluate(commandResult);
  return {
    id,
    title,
    status: evaluation.ok ? 'pass' : 'fail',
    summary: evaluation.summary,
    details: evaluation.details ?? '',
    commandResult,
  };
}

function e2ePort(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function e2ePorts() {
  return {
    web: e2ePort('W7_E2E_PORT', 13100),
    auth: e2ePort('W7_E2E_AUTH_PORT', 19099),
    firestore: e2ePort('W7_E2E_FIRESTORE_PORT', 18080),
    storage: e2ePort('W7_E2E_STORAGE_PORT', 19199),
    hub: e2ePort('W7_E2E_HUB_PORT', 14401),
    logging: e2ePort('W7_E2E_LOGGING_PORT', 14501),
    ui: e2ePort('W7_E2E_UI_PORT', 14001),
  };
}

function toFirebasePath(path) {
  return path.replace(/\\/g, '/');
}

function writeIsolatedFirebaseConfig(configPath, ports) {
  const config = {
    firestore: {
      rules: toFirebasePath(join(ROOT, 'firestore.rules')),
      indexes: toFirebasePath(join(ROOT, 'firestore.indexes.json')),
    },
    storage: {
      rules: toFirebasePath(join(ROOT, 'storage.rules')),
    },
    emulators: {
      auth: { host: '127.0.0.1', port: ports.auth },
      firestore: { host: '127.0.0.1', port: ports.firestore },
      storage: { host: '127.0.0.1', port: ports.storage },
      ui: { enabled: false, host: '127.0.0.1', port: ports.ui },
      hub: { host: '127.0.0.1', port: ports.hub },
      logging: { host: '127.0.0.1', port: ports.logging },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeIsolatedE2ERunner(runnerPath) {
  if (process.platform === 'win32') {
    writeFileSync(
      runnerPath,
      `@echo off\r\ncd /d "${WEB_DIR}"\r\nnpx.cmd playwright test\r\n`,
      'utf8',
    );
    return;
  }

  writeFileSync(
    runnerPath,
    `#!/usr/bin/env sh\ncd "${WEB_DIR}"\nexec npx playwright test\n`,
    'utf8',
  );
  chmodSync(runnerPath, 0o755);
}

function combineCommandResults(commandResults) {
  const first = commandResults[0];
  const last = commandResults[commandResults.length - 1];
  return {
    command: commandResults.map((result) => result.command).join(' && '),
    cwd: '.',
    startedAt: first.startedAt,
    finishedAt: last.finishedAt,
    exitCode: last.exitCode,
    stdout: commandResults.map((result) => result.stdout).filter(Boolean).join('\n'),
    stderr: commandResults.map((result) => result.stderr).filter(Boolean).join('\n'),
    error: commandResults.map((result) => result.error).filter(Boolean).join('\n') || null,
  };
}

function checkE2ESmoke() {
  const ports = e2ePorts();
  const configPath = join(tmpdir(), `owlette-w7-firebase-${process.pid}.json`);
  const runnerPath = join(
    tmpdir(),
    process.platform === 'win32'
      ? `owlette-w7-playwright-${process.pid}.cmd`
      : `owlette-w7-playwright-${process.pid}.sh`,
  );
  const fixtureDir = join(tmpdir(), `owlette-w7-fixtures-${process.pid}`);
  const outputDir = join(tmpdir(), `owlette-w7-results-${process.pid}`);
  const reportDir = join(tmpdir(), `owlette-w7-report-${process.pid}`);
  const nextDistDir = `e2e/.output/next-w7-${process.pid}`;
  const env = {
    E2E_PORT: String(ports.web),
    E2E_FIXTURES_DIR: fixtureDir,
    E2E_OUTPUT_DIR: outputDir,
    E2E_REPORT_DIR: reportDir,
    OWLETTE_NEXT_DIST_DIR: nextDistDir,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
    FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${ports.storage}`,
  };
  let passed = false;

  try {
    writeIsolatedFirebaseConfig(configPath, ports);
    writeIsolatedE2ERunner(runnerPath);
    mkdirSync(fixtureDir, { recursive: true });

    const buildResult = run([NPM, 'run', 'e2e:build'], { cwd: WEB_DIR, env });
    if (buildResult.exitCode !== 0) {
      return {
        id: 'e2e-smoke',
        title: 'E2E smoke against permissive rules',
        status: 'fail',
        summary: `e2e build exited ${buildResult.exitCode}`,
        details: `isolated ports web=${ports.web}, auth=${ports.auth}, firestore=${ports.firestore}, storage=${ports.storage}, next_dist=${nextDistDir}`,
        commandResult: buildResult,
      };
    }

    const testResult = run(
      [
        FIREBASE,
        'emulators:exec',
        '--config',
        configPath,
        '--only',
        'auth,firestore,storage',
        '--project',
        'demo-playwright-e2e',
        runnerPath,
      ],
      { cwd: ROOT, env },
    );
    passed = testResult.exitCode === 0;
    const commandResult = passed ? combineCommandResults([buildResult, testResult]) : testResult;
    return {
      id: 'e2e-smoke',
      title: 'E2E smoke against permissive rules',
      status: passed ? 'pass' : 'fail',
      summary: passed ? 'e2e suite passed' : `e2e exited ${testResult.exitCode}`,
      details: `isolated ports web=${ports.web}, auth=${ports.auth}, firestore=${ports.firestore}, storage=${ports.storage}, next_dist=${nextDistDir}, runner=${runnerPath}`,
      commandResult,
    };
  } finally {
    if (passed) {
      rmSync(configPath, { force: true });
      rmSync(runnerPath, { force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
      rmSync(join(WEB_DIR, nextDistDir), { recursive: true, force: true });
    }
  }
}

function checkAstScan() {
  const jsonPath = join(tmpdir(), `owlette-firestore-writes-${process.pid}.json`);
  try {
    const commandResult = run(
      ['node', 'scripts/scan-firestore-writes.mjs', `--json=${jsonPath}`, '--no-md'],
      { cwd: ROOT },
    );
    let parsed = null;
    if (existsSync(jsonPath)) {
      parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    }
    const totals = parsed?.totals ?? {};
    const ok =
      commandResult.exitCode === 0 &&
      totals.unclear === 0 &&
      totals.control_plane === 0;
    return {
      id: 'ast-scan',
      title: 'AST scan green',
      status: ok ? 'pass' : 'fail',
      summary: ok
        ? `0 control-plane writes and ${totals.preference ?? 0} preference writes`
        : `${totals.control_plane ?? 'unknown'} control-plane, ${totals.unclear ?? 'unknown'} unclear`,
      details: parsed
        ? `total=${totals.total}, preference=${totals.preference}, control_plane=${totals.control_plane}, no_action=${totals.no_action}, unclear=${totals.unclear}`
        : 'scanner JSON was not produced',
      commandResult,
    };
  } catch (err) {
    return {
      id: 'ast-scan',
      title: 'AST scan green',
      status: 'fail',
      summary: 'scanner execution or JSON parse failed',
      details: err instanceof Error ? err.message : String(err),
      commandResult: null,
    };
  } finally {
    rmSync(jsonPath, { force: true });
  }
}

function checkCalibrationReport() {
  if (!existsSync(CALIBRATION_PATH)) {
    return {
      id: 'rate-limit-calibration',
      title: 'Wave 8.0 calibration data captured',
      status: 'fail',
      summary: 'rate-limit calibration report is missing',
      details: `expected ${relative(ROOT, CALIBRATION_PATH)}`,
      commandResult: null,
    };
  }

  const body = readFileSync(CALIBRATION_PATH, 'utf8');
  const hasCompleteStatus = /^status:\s*complete\b/im.test(body);
  const hasW7LowTrafficWaiver =
    /^status:\s*risk accepted\b/im.test(body) &&
    /\bw7_rules_lockdown waiver:\s*accepted\b/im.test(body) &&
    /\brate-limit enforcement remains blocked\b/im.test(body);
  const hasSevenDays = /(?:7\+|>=?7|seven)\s+days?/i.test(body);
  const hasP99 = /\bp99\b/i.test(body);
  const hasPostCalibration = /post[- ]calibration|calibrated limit|updated default/i.test(body);
  const ok = hasW7LowTrafficWaiver || (hasCompleteStatus && hasSevenDays && hasP99 && hasPostCalibration);
  return {
    id: 'rate-limit-calibration',
    title: 'Wave 8.0 calibration data captured',
    status: ok ? 'pass' : 'fail',
    summary: hasW7LowTrafficWaiver
      ? 'low-traffic calibration risk accepted for W7 rules lockdown only'
      : ok
      ? 'calibration report includes duration, p99s, and calibrated limits'
      : 'calibration report is present but incomplete',
    details:
      `status=${hasCompleteStatus ? 'complete' : hasW7LowTrafficWaiver ? 'risk_accepted' : 'missing'}, ` +
      `duration=${hasSevenDays ? 'ok' : 'missing'}, ` +
      `p99=${hasP99 ? 'ok' : 'missing'}, ` +
      `post_calibration_limits=${hasPostCalibration ? 'ok' : 'missing'}`,
    commandResult: null,
  };
}

function checkDenialTests() {
  if (!existsSync(DENIAL_TEST_PATH)) {
    return {
      id: 'denial-tests',
      title: 'Denial tests already authored',
      status: 'fail',
      summary: 'denials.test.ts is missing',
      details: `expected ${relative(ROOT, DENIAL_TEST_PATH)}`,
      commandResult: null,
    };
  }

  const body = readFileSync(DENIAL_TEST_PATH, 'utf8');
  const hasFlipComment = body.includes('Wave 7 flips these to `test()` when rules lock down.');
  const failingCount = (body.match(/\btest\.failing\(/g) ?? []).length;
  const ok = hasFlipComment && failingCount > 0;
  return {
    id: 'denial-tests',
    title: 'Denial tests already authored',
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `${failingCount} dormant denial tests found`
      : 'denial test file exists but is missing wave-7 scaffolding',
    details: `wave7_comment=${hasFlipComment ? 'ok' : 'missing'}, test.failing_count=${failingCount}`,
    commandResult: null,
  };
}

function runChecks() {
  const checks = [];
  const add = (check) => {
    checks.push(check);
    return !(failFast && check.status !== 'pass');
  };

  if (!add(checkAstScan())) return checks;
  if (!add(commandCheck({
      id: 'eslint',
      title: 'ESLint green',
      command: [NPM, 'run', 'lint'],
      cwd: WEB_DIR,
      evaluate: (result) => ({
        ok: result.exitCode === 0,
        summary: result.exitCode === 0 ? 'eslint passed' : `eslint exited ${result.exitCode}`,
      }),
    }))) return checks;
  if (!add(commandCheck({
      id: 'typecheck',
      title: 'Typecheck green',
      command: [NPX, 'tsc', '--noEmit'],
      cwd: WEB_DIR,
      evaluate: (result) => ({
        ok: result.exitCode === 0,
        summary: result.exitCode === 0 ? 'tsc passed' : `tsc exited ${result.exitCode}`,
      }),
    }))) return checks;
  if (!add(commandCheck({
      id: 'build',
      title: 'Next build green',
      command: [NPM, 'run', 'build'],
      cwd: WEB_DIR,
      evaluate: (result) => ({
        ok: result.exitCode === 0,
        summary: result.exitCode === 0 ? 'next build passed' : `next build exited ${result.exitCode}`,
      }),
    }))) return checks;
  if (!add(commandCheck({
      id: 'openapi',
      title: 'OpenAPI spec validates',
      command: [NPM, 'run', 'validate:api'],
      cwd: WEB_DIR,
      evaluate: (result) => ({
        ok: result.exitCode === 0,
        summary: result.exitCode === 0 ? 'openapi validator passed' : `validator exited ${result.exitCode}`,
      }),
    }))) return checks;
  if (!add(commandCheck({
      id: 'reconciler-tests',
      title: 'Wave 2.4 reconciler tests green',
      command: [NPM, 'test'],
      cwd: FUNCTIONS_DIR,
      evaluate: (result) => ({
        ok: result.exitCode === 0,
        summary: result.exitCode === 0 ? 'functions test suite passed' : `functions tests exited ${result.exitCode}`,
      }),
    }))) return checks;
  if (!add(checkCalibrationReport())) return checks;
  if (!add(checkDenialTests())) return checks;
  add(checkE2ESmoke());
  return checks;
}

function renderReport({ generatedAt, gitSha, gitStatus, checks }) {
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const failCount = checks.filter((c) => c.status !== 'pass').length;
  const lines = [];

  lines.push('# lockdown readiness report');
  lines.push('');
  lines.push(`generated: ${generatedAt}`);
  lines.push(`git sha: \`${gitSha}\``);
  lines.push(`overall: **${failCount === 0 ? 'pass' : 'fail'}** (${passCount}/${checks.length} passed)`);
  lines.push('');
  lines.push('## checks');
  lines.push('');
  lines.push('| # | check | status | summary |');
  lines.push('| --- | --- | --- | --- |');
  checks.forEach((check, index) => {
    lines.push(`| ${index + 1} | ${check.title} | ${check.status} | ${escapePipe(check.summary)} |`);
  });
  lines.push('');

  for (const check of checks) {
    lines.push(`## ${check.title}`);
    lines.push('');
    lines.push(`status: **${check.status}**`);
    lines.push(`summary: ${check.summary}`);
    if (check.details) {
      lines.push(`details: ${check.details}`);
    }
    if (check.commandResult) {
      lines.push(`command: \`${check.commandResult.command}\``);
      lines.push(`cwd: \`${check.commandResult.cwd}\``);
      lines.push(`started: ${check.commandResult.startedAt}`);
      lines.push(`finished: ${check.commandResult.finishedAt}`);
      lines.push(`exit code: ${check.commandResult.exitCode}`);
      const output = truncateOutput(
        [check.commandResult.stdout, check.commandResult.stderr, check.commandResult.error]
          .filter(Boolean)
          .join('\n'),
      );
      if (output) {
        lines.push('');
        lines.push('```text');
        lines.push(output);
        lines.push('```');
      }
    }
    lines.push('');
  }

  lines.push('## git status');
  lines.push('');
  lines.push('```text');
  lines.push(gitStatus || '(clean)');
  lines.push('```');
  lines.push('');
  lines.push('Wave 7 may begin only when every check above passes at this same git sha.');
  lines.push('');

  return lines.join('\n');
}

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|');
}

function main() {
  const generatedAt = new Date().toISOString();
  const gitSha = gitValue(['git', 'rev-parse', 'HEAD']);
  const gitStatus = gitValue(['git', 'status', '--short'], '');
  const checks = runChecks();
  const report = renderReport({ generatedAt, gitSha, gitStatus, checks });

  if (writeReport) {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, report, 'utf8');
    process.stdout.write(`wrote ${relative(ROOT, REPORT_PATH)}\n`);
  }

  const failed = checks.filter((c) => c.status !== 'pass');
  if (failed.length === 0) {
    process.stdout.write('lockdown readiness: pass\n');
    process.exit(0);
  }

  process.stderr.write(`lockdown readiness: failed (${failed.length}/${checks.length})\n`);
  for (const check of failed) {
    process.stderr.write(`  - ${check.title}: ${check.summary}\n`);
  }
  process.exit(1);
}

main();
