#!/usr/bin/env npx tsx
/**
 * Validates the OpenAPI spec against the actual API route files.
 *
 * - Checks that every documented path maps to a real route file
 * - Warns if public-facing routes exist but aren't documented
 *
 * Usage: npx tsx scripts/validate-openapi.ts
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import yaml from 'js-yaml';
import {
  getOpenApiOperations,
  operationHasAuthScopeNote,
  operationHasExplicitSecurity,
  operationHasReferenceExample,
  renderOpenApiReference,
} from '../lib/openapiReference';

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
  '/api/agent/auth/device-code',
  '/api/agent/auth/device-code/authorize',
  '/api/agent/auth/device-code/poll',
  '/api/agent/alert',
  '/api/agent/screenshot',
  '/api/agent/generate-installer',
  '/api/alerts/trigger',
  '/api/bug-report',
  '/api/cortex/autonomous',
  '/api/cortex/categorize',
  '/api/cortex/escalation',
  '/api/cortex/provision-key',
  '/api/cron/display-alerts',
  '/api/cron/status-ping',
  '/api/settings/llm-key',
  '/api/settings/llm-models',
  '/api/settings/site-llm-key',
  '/api/cron/health-check',
  '/api/cron/process-alerts',
  '/api/legal/dmca',
  '/api/setup/generate-token',
  '/api/test-email',
  '/api/unsubscribe',
  '/api/webhooks/test',
  '/api/webhooks/user-created',
  '/api/openapi',
]);

function loadSpec(): Record<string, unknown> {
  if (!existsSync(SPEC_PATH)) {
    console.error('ERROR: openapi.yaml not found at', SPEC_PATH);
    process.exit(1);
  }
  return yaml.load(readFileSync(SPEC_PATH, 'utf-8')) as Record<string, unknown>;
}

/**
 * Convert an OpenAPI path like /api/sites/{siteId}/deployments/{deploymentId}
 * to a filesystem path like app/api/sites/[siteId]/deployments/[deploymentId]/route.ts
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
  return findRouteFiles(API_DIR)
    .map((filePath) => {
      const rel = relative(ROOT, filePath)
        .replace(/\\/g, '/')
        .replace(/^app\//, '/')
        .replace(/\/route\.ts$/, '')
        .replace(/\[([^\]]+)\]/g, '{$1}');
      return rel;
    });
}

function findRouteFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findRouteFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'route.ts') {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Roost (project distribution v2) routes — subject to strict drift gating.
 * Any route file under these prefixes must be documented in openapi.yaml.
 */
function isRoostRoute(routePath: string): boolean {
  return (
    routePath.startsWith('/api/chunks/') ||
    routePath.startsWith('/api/roosts/')
  );
}

/**
 * Any operation on a path object that carries `x-stub: true` marks the
 * path as documentation-first — the route file is expected NOT to exist
 * yet (public-api wave 1: openapi ships ahead of implementation).
 *
 * If any method on a path is stubbed we treat the whole path as stubbed;
 * mixed live/stub methods on a single path are not supported because Next
 * routes collapse methods into a single `route.ts`.
 */
function pathIsStub(pathItem: unknown): boolean {
  if (!pathItem || typeof pathItem !== 'object') return false;
  const obj = pathItem as Record<string, unknown>;
  if (obj['x-stub'] === true) return true;
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
    const op = obj[method];
    if (op && typeof op === 'object' && (op as Record<string, unknown>)['x-stub'] === true) {
      return true;
    }
  }
  return false;
}

function routeFileExportsMethod(routeFile: string, method: string): boolean {
  const source = readFileSync(routeFile, 'utf-8');
  const upperMethod = method.toUpperCase();
  return new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${upperMethod}\\b|export\\s+const\\s+${upperMethod}\\b|export\\s*\\{[^}]*\\b${upperMethod}\\b[^}]*\\}`,
  ).test(source);
}

function main() {
  const spec = loadSpec();
  const paths = (spec.paths || {}) as Record<string, unknown>;
  const specPaths = Object.keys(paths);
  const routePaths = discoverRoutes();
  const renderedSpec = renderOpenApiReference(spec);
  const renderedOperations = getOpenApiOperations(renderedSpec);

  let errors = 0;
  let warnings = 0;
  let stubs = 0;

  console.log(`\nValidating ${specPaths.length} documented paths against ${routePaths.length} route files...\n`);

  // Check 1: Every documented path should have a route file, unless the
  // path (or any operation on it) is marked `x-stub: true` to indicate
  // docs-before-implementation.
  for (const specPath of specPaths) {
    const routeFile = specPathToRoutePath(specPath);
    if (!existsSync(routeFile)) {
      if (pathIsStub(paths[specPath])) {
        stubs++;
        continue;
      }
      console.error(`ERROR: Documented path ${specPath} has no route file`);
      console.error(`       Expected: ${relative(ROOT, routeFile)}`);
      errors++;
    }
  }

  // Check 2: Warn about undocumented public routes. Roost routes
  // (/api/chunks/*, /api/roosts/*) are strict — missing docs are an
  // error, not a warning. This is the wave 1.12 drift gate: the roost
  // contract is the whole point of the spec, so silent drift there must
  // break CI.
  const specPathSet = new Set(specPaths);
  for (const routePath of routePaths) {
    if (specPathSet.has(routePath) || INTERNAL_ROUTES.has(routePath)) {
      continue;
    }
    if (isRoostRoute(routePath)) {
      console.error(
        `ERROR: Roost route ${routePath} is not documented in openapi.yaml`,
      );
      errors++;
    } else {
      console.warn(`WARN: Route ${routePath} exists but is not documented`);
      warnings++;
    }
  }

  // Check 3: Documented methods should also exist on the matched route
  // module. Next.js collapses HTTP methods into one route.ts file, so path
  // presence alone can miss a stale method in the OpenAPI contract.
  for (const { path, method } of getOpenApiOperations(spec)) {
    const pathItem = paths[path];
    const routeFile = specPathToRoutePath(path);
    if (!existsSync(routeFile) || pathIsStub(pathItem)) continue;
    if (!routeFileExportsMethod(routeFile, method)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is documented but not exported by ${relative(ROOT, routeFile)}`);
      errors++;
    }
  }

  // Check 4: Every source operation should declare its auth model
  // explicitly. Scalar renders operation-level security most clearly, so
  // protected endpoints should not rely on the global security fallback.
  for (const { path, method, operation } of getOpenApiOperations(spec)) {
    if (!operationHasExplicitSecurity(operation)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is missing operation-level security`);
      errors++;
    }
  }

  // Check 5: Validate the actual reference input served by /api/openapi.
  // The renderer enriches the YAML with examples and consistent auth/scope
  // notes, and this gate prevents the interactive docs from regressing to
  // a shape-only shell.
  for (const { path, method, operation } of renderedOperations) {
    if (!operationHasReferenceExample(operation)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is missing rendered examples`);
      errors++;
    }
    if (!operationHasAuthScopeNote(operation)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is missing rendered auth/scope notes`);
      errors++;
    }
  }

  // Summary
  console.log('');
  if (errors === 0 && warnings === 0 && stubs === 0) {
    console.log('All documented paths match route files. No undocumented public routes found.');
    console.log(`Rendered API reference includes examples and auth/scope notes for ${renderedOperations.length} operations.`);
  } else {
    if (errors > 0) console.error(`${errors} error(s) - OpenAPI route, auth, example, or scope validation`);
    if (warnings > 0) console.warn(`${warnings} warning(s) — undocumented routes`);
    if (stubs > 0) console.log(`${stubs} stub(s) — docs-first paths awaiting implementation (x-stub: true)`);
  }

  process.exit(errors > 0 ? 1 : 0);
}

main();
