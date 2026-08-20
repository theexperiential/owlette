/** @jest-environment node */

/**
 * Drift test for `infra/cron-jobs.json` — the registry of externally scheduled
 * endpoints (the cron-job.org jobs).
 *
 * The failure it guards is the quietest one we have: a scheduled route that exists
 * but was never registered produces no error, no email and no records — the work
 * simply never happens, and nothing in production tells you.
 *
 * Enforces: (1) every web/app/api/cron/ route directory has exactly one registry
 * entry and vice versa; (2) non-cron scheduled endpoints (e.g. /api/hoot/escalation)
 * point at a real route file, aliases included; (3) each entry's declared authHeader
 * still appears in its route source, so an auth-scheme change can't diverge quietly;
 * (4) the registry carries env var NAMES only, never a secret value; (5) every job
 * declares both dev and prod, since a job registered in one doesn't run in the other.
 *
 * Node builtins + jest globals only. No import.meta — jest transpiles to CJS.
 */

import fs from 'node:fs';
import path from 'node:path';

// web/__tests__/infra -> web/__tests__ -> web
const webRoot = path.resolve(__dirname, '..', '..');
// web -> repo root
const repoRoot = path.resolve(webRoot, '..');

const registryPath = path.join(repoRoot, 'infra', 'cron-jobs.json');
const appRoot = path.join(webRoot, 'app');
const cronRoutesRoot = path.join(appRoot, 'api', 'cron');

/** Next.js route handler filenames, in resolution order. */
const ROUTE_FILENAMES: readonly string[] = ['route.ts', 'route.tsx', 'route.js'];

/** Environments every scheduled job must be registered in. */
const REQUIRED_ENVIRONMENTS: readonly string[] = ['dev', 'prod'];

interface FailureMode {
  silent: boolean;
  description: string;
}

interface AliasRef {
  path: string;
  sourceFile: string;
  note?: string;
}

interface CronJobEntry {
  id: string;
  path: string;
  method: string;
  authHeader: string;
  authScheme?: string;
  authEnvVar: string;
  schedule: string;
  cadenceLabel: string;
  minTimeoutSeconds: number;
  environments: string[];
  /** Required only when `environments` omits one of REQUIRED_ENVIRONMENTS. */
  environmentsJustification?: string;
  urls: Record<string, string>;
  purpose: string;
  failureMode: FailureMode;
  detectedBy?: string;
  sourceFile: string;
  alias?: AliasRef;
  note?: string;
}

interface HostEntry {
  host: string;
  baseUrl: string;
  [key: string]: unknown;
}

interface CronJobRegistry {
  readme: string[];
  scheduler: Record<string, unknown>;
  hosts: Record<string, HostEntry>;
  jobs: CronJobEntry[];
}

if (!fs.existsSync(registryPath)) {
  throw new Error(
    `infra/cron-jobs.json not found at ${registryPath}. It is the canonical registry of ` +
      'externally scheduled endpoints and must exist for this test to have anything to check.',
  );
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as CronJobRegistry;
const jobs = registry.jobs;

/** Normalise a native path to forward slashes so assertions read the same on Windows. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Every directory at or below `dir` that contains a Next.js route handler. */
function collectRouteDirs(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && ROUTE_FILENAMES.includes(e.name))) {
    out.push(dir);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) collectRouteDirs(path.join(dir, entry.name), out);
  }
  return out;
}

/** `web/app/api/cron/talons` -> `/api/cron/talons` */
function apiPathForDir(absDir: string): string {
  return `/${toPosix(path.relative(appRoot, absDir))}`;
}

/**
 * `/api/cron/talons` -> the absolute route file, or null if there isn't one.
 *
 * Segment-for-segment. Route groups `(name)` and dynamic segments would break it —
 * no scheduled endpoint uses either, and this fails loudly rather than skipping.
 */
function routeFileFor(apiPath: string): string | null {
  const segments = apiPath.replace(/^\/+/, '').split('/');
  const dir = path.join(appRoot, ...segments);
  for (const name of ROUTE_FILENAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Absolute path -> repo-relative, forward-slashed (matches `sourceFile` values). */
function repoRelative(abs: string): string {
  return toPosix(path.relative(repoRoot, abs));
}

/** Every string value in the parsed registry, with a dotted path to it. */
function collectStrings(
  value: unknown,
  keyPath: string,
  out: Array<{ keyPath: string; value: string }> = [],
): Array<{ keyPath: string; value: string }> {
  if (typeof value === 'string') {
    out.push({ keyPath, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${keyPath}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, keyPath ? `${keyPath}.${key}` : key, out);
    }
  }
  return out;
}

/** Every object key name in the parsed registry, with a dotted path to it. */
function collectKeyPaths(value: unknown, keyPath: string, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectKeyPaths(item, `${keyPath}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const next = keyPath ? `${keyPath}.${key}` : key;
      out.push(next);
      collectKeyPaths(child, next, out);
    }
  }
  return out;
}

const discoveredCronPaths = collectRouteDirs(cronRoutesRoot).map(apiPathForDir).sort();
const registeredCronPaths = jobs
  .map((job) => job.path)
  .filter((p) => p.startsWith('/api/cron/'))
  .sort();

describe('infra/cron-jobs.json — shape', () => {
  it('declares at least one job and a host per required environment', () => {
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
    for (const env of REQUIRED_ENVIRONMENTS) {
      expect(registry.hosts[env]).toBeDefined();
      expect(typeof registry.hosts[env].host).toBe('string');
    }
  });

  it('uses unique ids', () => {
    const ids = jobs.map((job) => job.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('gives every job the fields an operator needs to register it', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      const label = job.id || job.path || '<unnamed entry>';
      if (!job.path || !job.path.startsWith('/api/')) {
        problems.push(`${label} — "path" must be an app route path starting with /api/`);
      }
      if (!job.method) problems.push(`${label} — missing "method"`);
      if (!job.authHeader) problems.push(`${label} — missing "authHeader"`);
      if (!job.authEnvVar) problems.push(`${label} — missing "authEnvVar"`);
      if (!job.schedule) problems.push(`${label} — missing "schedule"`);
      if (!job.cadenceLabel) problems.push(`${label} — missing "cadenceLabel"`);
      if (!job.purpose) problems.push(`${label} — missing "purpose"`);
      if (!job.sourceFile) problems.push(`${label} — missing "sourceFile"`);
      if (!Number.isInteger(job.minTimeoutSeconds) || job.minTimeoutSeconds <= 0) {
        problems.push(`${label} — "minTimeoutSeconds" must be a positive integer`);
      }
      if (typeof job.failureMode?.silent !== 'boolean') {
        problems.push(
          `${label} — "failureMode.silent" must be a boolean; an operator needs to know ` +
            'whether an unscheduled job announces itself or fails quietly',
        );
      }
      if (!job.failureMode?.description) {
        problems.push(`${label} — missing "failureMode.description"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('records sourceFile as the path the route actually resolves to', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      const resolved = routeFileFor(job.path);
      if (resolved && repoRelative(resolved) !== job.sourceFile) {
        problems.push(
          `${job.id} — "sourceFile" says ${job.sourceFile} but ${job.path} resolves to ` +
            `${repoRelative(resolved)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('every cron route is registered, and every registered cron route exists', () => {
  it('has a registry entry for every route under web/app/api/cron/', () => {
    const unregistered = discoveredCronPaths.filter((p) => !registeredCronPaths.includes(p));
    const problems = unregistered.map(
      (p) =>
        `${p} — has a route handler but no entry in infra/cron-jobs.json. ` +
          'Add an entry there, THEN register the job on cron-job.org for BOTH environments: ' +
          `https://dev.owlette.app${p} and https://owlette.app${p}, each with that ` +
          "environment's own CRON_SECRET. Unregistered, this route fails silently — nothing " +
          'errors, the work simply never happens.',
    );
    expect(problems).toEqual([]);
  });

  it('has a route under web/app/api/cron/ for every /api/cron/* registry entry', () => {
    const orphaned = registeredCronPaths.filter((p) => !discoveredCronPaths.includes(p));
    const problems = orphaned.map(
      (p) =>
        `${p} — listed in infra/cron-jobs.json but no route handler exists under ` +
          'web/app/api/cron/. If the endpoint was removed or renamed, drop the entry here AND ' +
          'delete the corresponding cron-job.org job in BOTH environments (dev.owlette.app and ' +
          'owlette.app) — an orphaned schedule hammers a 404 forever without telling anyone.',
    );
    expect(problems).toEqual([]);
  });

  it('registers each cron route exactly once', () => {
    const duplicates = registeredCronPaths.filter((p, i) => registeredCronPaths.indexOf(p) !== i);
    expect(duplicates).toEqual([]);
  });
});

describe('non-cron scheduled endpoints point at real route files', () => {
  it('resolves every registry path to a route handler', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      if (routeFileFor(job.path) === null) {
        problems.push(
          `${job.id} (${job.path}) — no route handler found at web/app${job.path}/route.ts. ` +
            'Either the route moved (update "path" and "sourceFile" here) or it was deleted ' +
            '(remove the entry AND the cron-job.org job in both environments).',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('resolves every declared back-compat alias to a route handler', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      if (!job.alias) continue;
      if (routeFileFor(job.alias.path) === null) {
        problems.push(
          `${job.id} — declared alias ${job.alias.path} has no route handler. Existing ` +
            'cron-job.org schedules may still point at it; either restore the alias or ' +
            'confirm every schedule has been moved to the canonical path first.',
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('declared auth header matches the route source', () => {
  it('finds each entry’s authHeader in its route file', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      const routeFile = routeFileFor(job.path);
      if (routeFile === null) continue; // already reported above
      const source = fs.readFileSync(routeFile, 'utf8');
      if (!source.toLowerCase().includes(job.authHeader.toLowerCase())) {
        problems.push(
          `${job.id} (${job.path}) — registry declares the "${job.authHeader}" header but ` +
            `${repoRelative(routeFile)} never reads it. If the auth scheme changed, update ` +
            'this entry AND re-register the job on cron-job.org for both environments — a ' +
            'scheduler sending the old header shape gets a silent 401 and fires nothing.',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('names the env var carrying the credential, not the credential', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(job.authEnvVar)) {
        problems.push(
          `${job.id} — "authEnvVar" must be an env var NAME (SCREAMING_SNAKE_CASE), got ` +
            `"${job.authEnvVar}". Values belong in the hosting provider, never in this file.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the registry carries no secret values', () => {
  // Applied to parsed VALUES, not the raw file text, so JSON punctuation can't
  // trigger a false positive.
  const SECRET_SHAPES: Array<{ name: string; pattern: RegExp }> = [
    { name: 'long hex run (32+ chars)', pattern: /[0-9a-f]{32,}/i },
    { name: 'owlette api key (owk_...)', pattern: /owk_[A-Za-z0-9_-]{8,}/ },
    { name: 'resend api key (re_...)', pattern: /\bre_[A-Za-z0-9]{16,}/ },
    { name: 'sentry token (sntry...)', pattern: /sntry[a-z]*_[A-Za-z0-9]{8,}/i },
    { name: 'pem private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    // A literal token after "Bearer". `<PLACEHOLDER>` forms are allowed.
    { name: 'literal bearer token', pattern: /bearer\s+(?!<)[A-Za-z0-9+/=_.-]{12,}/i },
  ];

  const INLINE_ASSIGNMENT = /(secret|token|password|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{12,})/gi;
  const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

  it('contains no secret-shaped string anywhere', () => {
    const hits: string[] = [];
    for (const { keyPath, value } of collectStrings(registry, '')) {
      for (const { name, pattern } of SECRET_SHAPES) {
        if (pattern.test(value)) {
          hits.push(`${keyPath} — looks like a ${name}`);
        }
      }

      INLINE_ASSIGNMENT.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INLINE_ASSIGNMENT.exec(value)) !== null) {
        // `CRON_SECRET: CRON_SECRET` is a name, not a value — allow it.
        if (!ENV_VAR_NAME.test(match[2])) {
          hits.push(`${keyPath} — inline credential assignment near "${match[0].slice(0, 40)}"`);
        }
      }

      // High-entropy bare token: mixed case + digits, no separators.
      for (const token of value.split(/\s+/)) {
        if (
          /^[A-Za-z0-9+/=_-]{24,}$/.test(token) &&
          /[a-z]/.test(token) &&
          /[A-Z]/.test(token) &&
          /[0-9]/.test(token)
        ) {
          hits.push(`${keyPath} — high-entropy token "${token.slice(0, 12)}..."`);
        }
      }
    }

    const problems = hits.map(
      (hit) =>
        `${hit}. infra/cron-jobs.json holds env var NAMES only — move the value to the ` +
        'hosting provider (see scripts/env-manifest.json) and reference it by name. If this ' +
        'is a false positive, rewrite the string rather than loosening the check.',
    );
    expect(problems).toEqual([]);
  });

  it('has no field named like a credential', () => {
    const suspicious = collectKeyPaths(registry, '').filter((keyPath) => {
      const leaf = keyPath.split('.').pop() ?? '';
      return /(secret|token|password|passphrase|credential)/i.test(leaf);
    });
    const problems = suspicious.map(
      (keyPath) =>
        `${keyPath} — field name implies it holds a credential. Reference the env var by ` +
        'name via "authEnvVar" instead.',
    );
    expect(problems).toEqual([]);
  });
});

describe('every job is registered per environment', () => {
  it('declares both dev and prod, or justifies the omission explicitly', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      const declared = Array.isArray(job.environments) ? job.environments : [];
      const missing = REQUIRED_ENVIRONMENTS.filter((env) => !declared.includes(env));
      if (missing.length === 0) continue;

      const justification = (job.environmentsJustification ?? '').trim();
      if (justification.length < 20) {
        problems.push(
          `${job.id} — does not declare ${missing.join(' + ')}. Every scheduled endpoint is ` +
            'registered once per environment, each with that environment’s own ' +
            'CRON_SECRET. If this one is genuinely single-environment, add an ' +
            '"environmentsJustification" field saying why.',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('declares only environments that have a host', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      for (const env of job.environments ?? []) {
        if (!registry.hosts[env]) {
          problems.push(`${job.id} — declares environment "${env}" with no entry under "hosts"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives a copy-pasteable url per declared environment that matches the host and path', () => {
    const problems: string[] = [];
    for (const job of jobs) {
      for (const env of job.environments ?? []) {
        const raw = job.urls?.[env];
        if (!raw) {
          problems.push(`${job.id} — missing urls.${env}`);
          continue;
        }
        const host = registry.hosts[env]?.host;
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          problems.push(`${job.id} — urls.${env} is not a valid url: ${raw}`);
          continue;
        }
        if (parsed.hostname !== host) {
          problems.push(`${job.id} — urls.${env} points at ${parsed.hostname}, expected ${host}`);
        }
        if (parsed.pathname !== job.path) {
          problems.push(
            `${job.id} — urls.${env} path is ${parsed.pathname}, expected ${job.path}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
