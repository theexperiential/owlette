#!/usr/bin/env node
/**
 * check-status-page-ready - public API Wave 5.1 status-page gate.
 *
 * Validates that the local operator environment has the status-page variables
 * needed for `/api/cron/status-ping`. With `--probe-url`, it also calls a live
 * status-ping route and summarizes component health without printing secrets.
 */

const STATUS_COMPONENTS = [
  'dashboard',
  'api',
  'agent_registry',
  'webhook_delivery',
  'r2_uploads',
  'firestore',
  'cortex_chat',
];

const COMPONENT_ENV = {
  dashboard: 'INSTATUS_COMPONENT_DASHBOARD_ID',
  api: 'INSTATUS_COMPONENT_API_ID',
  agent_registry: 'INSTATUS_COMPONENT_AGENT_REGISTRY_ID',
  webhook_delivery: 'INSTATUS_COMPONENT_WEBHOOK_DELIVERY_ID',
  r2_uploads: 'INSTATUS_COMPONENT_R2_UPLOADS_ID',
  firestore: 'INSTATUS_COMPONENT_FIRESTORE_ID',
  cortex_chat: 'INSTATUS_COMPONENT_CORTEX_CHAT_ID',
};

const REQUIRED_ENV = [
  'CRON_SECRET',
  'INSTATUS_API_KEY',
  'INSTATUS_PAGE_ID',
  ...STATUS_COMPONENTS.map((component) => COMPONENT_ENV[component]),
];

const OPTIONAL_URL_ENV = [
  'OWLETTE_STATUS_BASE_URL',
  'INSTATUS_API_BASE_URL',
];

const DEFAULT_TIMEOUT_MS = 15_000;

function usage() {
  console.log(`Usage:
  node scripts/check-status-page-ready.mjs --env-only
  node scripts/check-status-page-ready.mjs --probe-url https://owlette.app/api/cron/status-ping
  node scripts/check-status-page-ready.mjs --base-url https://owlette.app

Options:
  --env-only              Check required environment variables only.
  --probe-url <url>       Call a live /api/cron/status-ping URL.
  --base-url <url>        Build the probe URL as <url>/api/cron/status-ping.
  --json                  Emit machine-readable JSON.
  --help                  Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    envOnly: false,
    json: false,
    probeUrl: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--env-only') {
      options.envOnly = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--probe-url') {
      options.probeUrl = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--base-url') {
      const baseUrl = (argv[index + 1] || '').replace(/\/+$/, '');
      options.probeUrl = baseUrl ? `${baseUrl}/api/cron/status-ping` : '';
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.probeUrl) options.envOnly = true;
  return options;
}

function isSet(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
}

function checkUrl(name, value, checks) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      checks.push({
        level: 'fail',
        name,
        message: 'must be an http or https URL',
      });
      return;
    }
    checks.push({ level: 'pass', name, message: 'valid URL' });
  } catch {
    checks.push({ level: 'fail', name, message: 'must be a valid URL' });
  }
}

function checkEnvironment() {
  const checks = [];

  for (const name of REQUIRED_ENV) {
    checks.push({
      level: isSet(name) ? 'pass' : 'fail',
      name,
      message: isSet(name) ? 'set' : 'missing',
    });
  }

  if (isSet('CRON_SECRET') && process.env.CRON_SECRET.trim().length < 32) {
    checks.push({
      level: 'fail',
      name: 'CRON_SECRET',
      message: 'set but shorter than 32 characters',
    });
  }

  const method = process.env.INSTATUS_COMPONENT_STATUS_METHOD || 'PUT';
  if (!['PUT', 'PATCH', 'POST'].includes(method.toUpperCase())) {
    checks.push({
      level: 'fail',
      name: 'INSTATUS_COMPONENT_STATUS_METHOD',
      message: 'must be PUT, PATCH, or POST when set',
    });
  } else {
    checks.push({
      level: 'pass',
      name: 'INSTATUS_COMPONENT_STATUS_METHOD',
      message: `using ${method.toUpperCase()}`,
    });
  }

  const template = process.env.INSTATUS_COMPONENT_STATUS_URL_TEMPLATE || '';
  if (template) {
    if (!template.includes('{componentId}')) {
      checks.push({
        level: 'fail',
        name: 'INSTATUS_COMPONENT_STATUS_URL_TEMPLATE',
        message: 'must include {componentId}',
      });
    } else {
      checks.push({
        level: 'pass',
        name: 'INSTATUS_COMPONENT_STATUS_URL_TEMPLATE',
        message: 'contains {componentId}',
      });
    }
  }

  for (const name of OPTIONAL_URL_ENV) {
    checkUrl(name, process.env[name], checks);
  }

  const componentIds = STATUS_COMPONENTS
    .map((component) => [component, process.env[COMPONENT_ENV[component]]])
    .filter((entry) => typeof entry[1] === 'string' && entry[1].trim().length > 0);
  const seen = new Map();
  for (const [component, id] of componentIds) {
    const prior = seen.get(id);
    if (prior) {
      checks.push({
        level: 'fail',
        name: COMPONENT_ENV[component],
        message: `duplicates ${COMPONENT_ENV[prior]}`,
      });
    }
    seen.set(id, component);
  }

  return checks;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeStatusPing(probeUrl) {
  const checks = [];
  checkUrl('probe URL', probeUrl, checks);
  if (checks.some((check) => check.level === 'fail')) return { checks };

  if (!isSet('CRON_SECRET')) {
    checks.push({
      level: 'fail',
      name: 'probe auth',
      message: 'CRON_SECRET is required for live probe',
    });
    return { checks };
  }

  try {
    const response = await fetchWithTimeout(probeUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Cron-Secret': process.env.CRON_SECRET,
      },
    });
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }

    checks.push({
      level: response.ok ? 'pass' : 'fail',
      name: 'status-ping HTTP',
      message: `${response.status}`,
    });

    if (!body || !Array.isArray(body.results)) {
      checks.push({
        level: 'fail',
        name: 'status-ping body',
        message: 'missing results array',
      });
      return { checks, body };
    }

    const observedComponents = new Set(body.results.map((entry) => entry.component));
    for (const component of STATUS_COMPONENTS) {
      const result = body.results.find((entry) => entry.component === component);
      if (!result) {
        checks.push({
          level: 'fail',
          name: component,
          message: 'missing from live results',
        });
        continue;
      }
      checks.push({
        level: result.ok ? 'pass' : 'fail',
        name: component,
        message: result.ok ? 'healthy' : result.error || 'unhealthy',
      });
    }

    for (const component of observedComponents) {
      if (!STATUS_COMPONENTS.includes(component)) {
        checks.push({
          level: 'warn',
          name: component,
          message: 'unexpected component in live results',
        });
      }
    }

    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      checks.push({
        level: 'warn',
        name: 'component publish',
        message: 'no status transition observed; run the degraded/recovery drill separately',
      });
    }

    if (body.statusPage && body.statusPage.configured === false) {
      checks.push({
        level: 'fail',
        name: 'status-page config',
        message: `missing ${Array.isArray(body.statusPage.missing) ? body.statusPage.missing.join(', ') : 'configuration'}`,
      });
    }

    if (body.statusPage?.publish && Number(body.statusPage.publish.failed) > 0) {
      checks.push({
        level: 'fail',
        name: 'component publish',
        message: `${body.statusPage.publish.failed} publish attempt(s) failed`,
      });
    }

    return { checks, body };
  } catch (error) {
    checks.push({
      level: 'fail',
      name: 'status-ping probe',
      message: error instanceof Error ? error.message : String(error),
    });
    return { checks };
  }
}

function printChecks(checks) {
  const labels = {
    pass: 'PASS',
    warn: 'WARN',
    fail: 'FAIL',
  };
  for (const check of checks) {
    console.log(`[${labels[check.level]}] ${check.name}: ${check.message}`);
  }
}

function summarize(checks) {
  return {
    pass: checks.filter((check) => check.level === 'pass').length,
    warn: checks.filter((check) => check.level === 'warn').length,
    fail: checks.filter((check) => check.level === 'fail').length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const envChecks = checkEnvironment();
  const probe = options.envOnly ? { checks: [] } : await probeStatusPing(options.probeUrl);
  const checks = [...envChecks, ...probe.checks];
  const summary = summarize(checks);

  if (options.json) {
    console.log(JSON.stringify({ summary, checks }, null, 2));
  } else {
    printChecks(checks);
    console.log(`\nSummary: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  }

  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
