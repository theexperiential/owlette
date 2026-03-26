#!/usr/bin/env npx tsx
/**
 * Validates the OpenAPI spec against the actual API route files.
 *
 * - Checks that every documented path maps to a real route file
 * - Warns if public-facing routes exist but aren't documented
 *
 * Usage: npx tsx scripts/validate-openapi.ts
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

const ROOT = join(__dirname, '..');
const SPEC_PATH = join(ROOT, 'openapi.yaml');
const API_DIR = join(ROOT, 'app', 'api');

// Routes that are intentionally not documented (internal only)
const INTERNAL_ROUTES = new Set([
  '/api/auth/session',
  '/api/mfa/setup',
  '/api/mfa/verify-setup',
  '/api/mfa/verify-login',
  '/api/passkeys/register/options',
  '/api/passkeys/register/verify',
  '/api/passkeys/authenticate/options',
  '/api/passkeys/authenticate/verify',
  '/api/passkeys/list',
  '/api/passkeys/{credentialId}',
  '/api/agent/auth/exchange',
  '/api/agent/auth/refresh',
  '/api/agent/alert',
  '/api/agent/screenshot',
  '/api/agent/generate-installer',
  '/api/cortex/autonomous',
  '/api/cortex/escalation',
  '/api/cortex/provision-key',
  '/api/settings/llm-key',
  '/api/settings/site-llm-key',
  '/api/cron/health-check',
  '/api/setup/generate-token',
  '/api/test-email',
  '/api/unsubscribe',
  '/api/webhooks/user-created',
  '/api/admin/events/simulate',
  '/api/admin/tokens/list',
  '/api/admin/tokens/revoke',
  '/api/admin/installer/upload',
  '/api/admin/fetch-td-version',
  '/api/openapi',
]);

function loadSpec(): Record<string, any> {
  if (!existsSync(SPEC_PATH)) {
    console.error('ERROR: openapi.yaml not found at', SPEC_PATH);
    process.exit(1);
  }
  return yaml.load(readFileSync(SPEC_PATH, 'utf-8')) as Record<string, any>;
}

/**
 * Convert an OpenAPI path like /api/admin/processes/{processId}
 * to a filesystem path like app/api/admin/processes/[processId]/route.ts
 */
function specPathToRoutePath(specPath: string): string {
  const segments = specPath
    .replace(/^\/api\//, 'app/api/')
    .split('/')
    .map((seg) => (seg.startsWith('{') && seg.endsWith('}') ? `[${seg.slice(1, -1)}]` : seg));
  return join(ROOT, ...segments, 'route.ts');
}

/**
 * Find all route.ts files under app/api/ and convert them to API paths.
 */
function discoverRoutes(): string[] {
  const result = execSync(`find "${API_DIR}" -name "route.ts" -type f`, { encoding: 'utf-8' });
  return result
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((filePath) => {
      const rel = relative(ROOT, filePath)
        .replace(/\\/g, '/')
        .replace(/^app\//, '/')
        .replace(/\/route\.ts$/, '')
        .replace(/\[([^\]]+)\]/g, '{$1}');
      return rel;
    });
}

function main() {
  const spec = loadSpec();
  const specPaths = Object.keys(spec.paths || {});
  const routePaths = discoverRoutes();

  let errors = 0;
  let warnings = 0;

  console.log(`\nValidating ${specPaths.length} documented paths against ${routePaths.length} route files...\n`);

  // Check 1: Every documented path should have a route file
  for (const specPath of specPaths) {
    const routeFile = specPathToRoutePath(specPath);
    if (!existsSync(routeFile)) {
      console.error(`ERROR: Documented path ${specPath} has no route file`);
      console.error(`       Expected: ${relative(ROOT, routeFile)}`);
      errors++;
    }
  }

  // Check 2: Warn about undocumented public routes
  const specPathSet = new Set(specPaths);
  for (const routePath of routePaths) {
    if (!specPathSet.has(routePath) && !INTERNAL_ROUTES.has(routePath)) {
      console.warn(`WARN: Route ${routePath} exists but is not documented`);
      warnings++;
    }
  }

  // Summary
  console.log('');
  if (errors === 0 && warnings === 0) {
    console.log('All documented paths match route files. No undocumented public routes found.');
  } else {
    if (errors > 0) console.error(`${errors} error(s) — documented paths with no route file`);
    if (warnings > 0) console.warn(`${warnings} warning(s) — undocumented routes`);
  }

  process.exit(errors > 0 ? 1 : 0);
}

main();
