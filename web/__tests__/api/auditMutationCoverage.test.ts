/**
 * @jest-environment node
 *
 * Audit-mutation coverage gate.
 *
 * `lib/auditLogClient.ts` promises that every mutating route produces an audit
 * entry. This test is the enforcement of that promise: a static source scan
 * (pure `fs` reads — no route imports, no execution) over every
 * `app/api/**` `route.ts` that exports POST / PUT / PATCH / DELETE.
 *
 * A route counts as **audited** when its own source — or the source of a
 * module it imports one level out from `lib/actions/`, `lib/talons/`, or a
 * co-located `app/api/**` helper — calls one of:
 *
 *   - `authorizedSiteHandler(...)`     — writes a blocking allow/deny audit row
 *   - `authorizedPlatformHandler(...)` — same, on the platform audit path
 *   - `emitMutation(...)`              — the mutation-taxonomy audit event
 *
 * Granularity is the route **file**, not the individual method: those markers
 * are file-level constructs, so a file mixing an audited POST with an
 * unaudited DELETE cannot be told apart statically. That is a known limit of a
 * source scan, and the reason the lists below are curated by hand.
 *
 * The test fails when a mutating route is neither audited, exempt, nor a
 * declared known gap (a new unaudited route is a regression), and when an
 * entry in either list is stale (gone, no longer mutating, or now audited).
 * Both lists may only shrink truthfully.
 */

import fs from 'fs';
import path from 'path';

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.join(WEB_ROOT, 'app', 'api');

/* -------------------------------------------------------------------------- */
/*  the two curated lists                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mutating routes that legitimately produce no marker-detected mutation audit
 * — either because there is no privileged actor / no persistent state change
 * to attribute, or because the route writes its audit row through another
 * mechanism. Entries are route directories relative to `app/api/`, alphabetized,
 * each with its justification.
 */
export const EXEMPT_ROUTES: readonly string[] = [
  // agent-originated alert telemetry (agent bearer token); sends email/webhook, no operator mutation.
  'agent/alert',
  // pairing-phrase issuance for a not-yet-authenticated agent — bootstrap step of the device-code flow.
  'agent/auth/device-code',
  // agent polls for its own pairing result; token-flow lease state, no operator actor.
  'agent/auth/device-code/poll',
  // registration-code -> token exchange; agent authentication itself, no operator actor.
  'agent/auth/exchange',
  // agent refresh-token rotation; authentication lifecycle, no operator actor.
  'agent/auth/refresh',
  // agent screenshot ingest (agent bearer token); telemetry upload, not an operator mutation.
  'agent/screenshot',
  // internal-secret endpoint called by the alert cloud function; sends notifications only.
  'alerts/trigger',
  // public unauthenticated password-reset email send; no actor to attribute, enumeration-safe by design.
  'auth/forgot-password',
  // session create/destroy (sign-in / sign-out); the authentication act, not a resource mutation.
  'auth/session',
  // stripe-signed webhook ingress; the signature is the only credential, there is no owlette actor.
  'billing/stripe-webhook',
  // user-submitted bug/feature intake into `bug_reports`; touches no fleet, account, or security state.
  'bug-report',
  // read-only upload negotiation — returns which chunk hashes are missing, writes nothing.
  'chunks/check',
  // read-only: mints short-lived presigned GET urls, writes nothing.
  'chunks/download-urls',
  // mints presigned PUT urls into the immutable content-addressed store; the roost publish that references them is audited.
  'chunks/upload-urls',
  // CLI pairing-phrase issuance, unauthenticated bootstrap step of the device-code flow.
  'cli/device-code',
  // CLI polls for its own pairing result; token-flow state, no operator actor.
  'cli/device-code/poll',
  // internal-secret endpoint (CORTEX_INTERNAL_SECRET) invoked by the alert path; no user actor.
  'cortex/autonomous',
  // internal-secret + cron-secret escalation notifier; no user actor.
  'cortex/escalation',
  // public DMCA § 512(c)(3) notice intake; touches no fleet, account, or security state.
  'legal/dmca',
  // login-time TOTP / backup-code verification (+ optional device-trust cookie); the sign-in ceremony.
  'mfa/verify-login',
  // WebAuthn login ceremony: ephemeral challenge issuance, no credential state.
  'passkeys/authenticate/options',
  // WebAuthn login ceremony: verifies an assertion and starts a session; sign-in, not a mutation.
  'passkeys/authenticate/verify',
  // WebAuthn registration ceremony: ephemeral challenge issuance; the credential is persisted by register/verify.
  'passkeys/register/options',
  // read-only: re-mints a short-lived signed GET url for an already-published version body.
  'roosts/[roostId]/version-url',
  // read-only: lists the provider's available models for a supplied/stored key, writes nothing.
  'settings/llm-models',
  // agent-side screenshot pipeline (machine scope): publishes the uploaded object and records the capture.
  'sites/[siteId]/machines/[machineId]/screenshots/finalize',
  // agent-side screenshot pipeline (machine scope): mints a signed PUT url, writes nothing.
  'sites/[siteId]/machines/[machineId]/screenshots/upload-url',
  // internal-secret ingress called by the onTalonLogEventCreated cloud function; runs
  // already-authored talons, which audit their own disables from the engine. No operator actor.
  'talons/internal/match',
  // superadmin template preview send; email only, no persisted state.
  'test-email',
  // self-delete cascade: writes its own blocking `global/audit_log` row inline (see the route header).
  'users/me',
  // stateless signature probe against a caller-supplied url; creates or modifies no subscription.
  'webhooks/probe',
  // test delivery to an existing subscription; only stamps `lastTriggered`, no configuration change.
  'webhooks/test',
  // signup notification email to the admin address; reads the caller's own user doc, writes nothing.
  'webhooks/user-created',
];

/**
 * Mutating routes that are NOT audited today and that later waves will
 * remediate. Entries are route directories relative to `app/api/`, alphabetized,
 * each with the mutation that currently goes unrecorded. This list may only
 * shrink: once a route is audited its entry must be deleted, and the test fails
 * until it is.
 */
export const KNOWN_GAPS: readonly string[] = [
  // operator (session) binds a pairing machine to a site and mints its agent credentials.
  'agent/auth/device-code/authorize',
  // operator (session) mints a single-use agent registration code for a site.
  'agent/generate-installer',
  // account owner starts a subscription checkout and links a stripe customer to their account.
  'billing/checkout',
  // account owner opens a stripe portal session that can cancel the subscription.
  'billing/portal',
  // operator (session) mints an owk_* api key with caller-chosen scopes; POST /api/keys is audited, this path is not.
  'cli/device-code/authorize',
  // chat turn: creates turn state and relays tool calls that can reach the fleet.
  'cortex',
  // writes an LLM-generated title/category onto the caller's conversation (a rename, per the chat_mutated taxonomy).
  'cortex/categorize',
  // queues a machine command that installs an LLM api key into the agent's config.
  'cortex/provision-key',
  // cancels an in-flight turn (writes the stream doc terminal state).
  'cortex/stop',
  // stores a pending TOTP secret against the account; `mfa/disable` is audited, enrollment is not.
  'mfa/setup',
  // enables MFA on the account and persists the encrypted secret + backup codes.
  'mfa/verify-setup',
  // renames (PATCH) or deletes (DELETE) an account passkey credential.
  'passkeys/[credentialId]',
  // persists a new WebAuthn credential on the account.
  'passkeys/register/verify',
  // stores or removes the caller's encrypted user-level LLM api key.
  'settings/llm-key',
  // stores or removes a site-level encrypted LLM api key (admin-only).
  'settings/site-llm-key',
  // operator (session) mints an agent registration code for a site.
  'setup/generate-token',
];

/* -------------------------------------------------------------------------- */
/*  scanner                                                                   */
/* -------------------------------------------------------------------------- */

const MUTATING_METHODS = ['DELETE', 'PATCH', 'POST', 'PUT'] as const;

/** Call-site patterns that constitute "this route is audited". */
const AUDIT_MARKERS: readonly RegExp[] = [
  /\bauthorizedSiteHandler\s*(?:<[^>]*>)?\s*\(/,
  /\bauthorizedPlatformHandler\s*(?:<[^>]*>)?\s*\(/,
  /\bemitMutation\s*\(/,
];

/**
 * Directories whose modules are followed one level out from a route file.
 * `app/api` is included for co-located private helpers — the process control
 * verbs (`.../processes/{processId}/start` etc.) delegate their whole handler,
 * audit included, to a sibling `_helpers.ts`.
 *
 * Deliberately NOT the whole of `lib/`: `lib/auditLogClient.ts` *defines*
 * `emitMutation`, so following every `@/lib/...` import would mark any route
 * that merely imports `emitApiKeyUsed` as audited.
 */
const AUDITABLE_MODULE_DIRS = [
  API_ROOT,
  path.join(WEB_ROOT, 'lib', 'actions'),
  path.join(WEB_ROOT, 'lib', 'talons'),
];

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `__`-prefixed directories are transient test fixtures, not routes —
    // authorizedHandler.eslint.test.ts materializes app/api/__eslint_fixture_*/
    // route.ts files mid-run, and scanning them is a parallel-suite race.
    if (entry.name.startsWith('__')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/**
 * Drop comments so a marker named only in prose never counts as a call site —
 * several `lib/*.server.ts` modules discuss `authorizedSiteHandler` in their
 * header docs.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const sourceCache = new Map<string, string>();

function readStripped(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const stripped = stripComments(fs.readFileSync(file, 'utf8'));
  sourceCache.set(file, stripped);
  return stripped;
}

function exportedMutatingMethods(source: string): string[] {
  return MUTATING_METHODS.filter(
    (method) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source) ||
      new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\b`).test(source),
  );
}

function hasAuditMarker(source: string): boolean {
  return AUDIT_MARKERS.some((marker) => marker.test(source));
}

/** Every module specifier a file imports (static `from '…'` + dynamic `import('…')`). */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

/**
 * Resolve one level of `@/…` and relative imports, keeping only those that
 * land on a real file inside an auditable module directory.
 */
function resolveAuditableImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(WEB_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  const inAuditableDir = AUDITABLE_MODULE_DIRS.some(
    (dir) => base === dir || base.startsWith(dir + path.sep),
  );
  if (!inAuditableDir) return null;

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ScannedRoute {
  /** Route directory relative to `app/api/`, e.g. `sites/[siteId]/alerts`. */
  id: string;
  methods: string[];
  audited: boolean;
}

function scanRoutes(): ScannedRoute[] {
  return walkRouteFiles(API_ROOT)
    .map((file) => {
      const source = readStripped(file);
      const id = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/');

      const audited =
        hasAuditMarker(source) ||
        moduleSpecifiers(source).some((specifier) => {
          const resolved = resolveAuditableImport(file, specifier);
          return resolved !== null && hasAuditMarker(readStripped(resolved));
        });

      return { id, methods: exportedMutatingMethods(source), audited };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const routes = scanRoutes();
const mutatingRoutes = routes.filter((route) => route.methods.length > 0);
const byId = new Map(routes.map((route) => [route.id, route]));

function staleEntries(list: readonly string[]): string[] {
  return list.filter((id) => {
    const route = byId.get(id);
    if (!route) return true; // route deleted or renamed
    if (route.methods.length === 0) return true; // no longer mutating
    return route.audited; // remediated — entry must go
  });
}

/* -------------------------------------------------------------------------- */
/*  tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('audit coverage of mutating api routes', () => {
  it('scans the whole api tree', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(mutatingRoutes.length).toBeGreaterThan(50);
  });

  it('every mutating route is audited, exempt, or a declared known gap', () => {
    const unclassified = mutatingRoutes
      .filter(
        (route) =>
          !route.audited &&
          !EXEMPT_ROUTES.includes(route.id) &&
          !KNOWN_GAPS.includes(route.id),
      )
      .map((route) => `${route.id} [${route.methods.join(',')}]`);

    expect(unclassified).toEqual([]);
  });

  it('has no stale KNOWN_GAPS entries', () => {
    expect(staleEntries(KNOWN_GAPS)).toEqual([]);
  });

  it('has no stale EXEMPT_ROUTES entries', () => {
    expect(staleEntries(EXEMPT_ROUTES)).toEqual([]);
  });

  it('keeps both lists alphabetized, deduplicated, and disjoint', () => {
    expect(EXEMPT_ROUTES).toEqual([...EXEMPT_ROUTES].sort());
    expect(KNOWN_GAPS).toEqual([...KNOWN_GAPS].sort());
    expect([...new Set(EXEMPT_ROUTES)]).toEqual([...EXEMPT_ROUTES]);
    expect([...new Set(KNOWN_GAPS)]).toEqual([...KNOWN_GAPS]);
    expect(EXEMPT_ROUTES.filter((id) => KNOWN_GAPS.includes(id))).toEqual([]);
  });
});
