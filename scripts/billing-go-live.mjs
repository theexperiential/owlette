#!/usr/bin/env node
/**
 * Billing Go-Live (billing-system tasks 5.1 + 5.3)
 *
 * The operator tooling for the two moments that take owlette out of beta:
 * announcing the go-live date (T-30) and starting every account's trial
 * clock on it (T0). Both are one-shot, fleet-wide writes against production
 * data, so both are idempotent, both have a `--dry-run`, and the T0 run
 * refuses to start until its prerequisites are demonstrably met.
 *
 *   node scripts/billing-go-live.mjs status   --env=dev
 *   node scripts/billing-go-live.mjs announce --env=dev --golive=2026-09-15T17:00:00Z --dry-run
 *   node scripts/billing-go-live.mjs announce --env=dev --golive=2026-09-15T17:00:00Z
 *   node scripts/billing-go-live.mjs stamp    --env=prod --dry-run
 *   node scripts/billing-go-live.mjs stamp    --env=prod
 *
 * ## what each mode does
 *
 * **announce** — writes `config/billing { goLiveAt }`, the one deployment-wide
 * document that (a) switches the dashboard trial banner into its announcement
 * state (`web/app/api/billing/snapshot/route.ts` → `TrialBanner.tsx`) and
 * (b) arms the bootstrap clock gate (`trialClockStarted()` in
 * `web/lib/actions/bootstrapUser.server.ts`): signups before that instant keep
 * minting the `trialEndsAt: null` sentinel, signups after it self-start a real
 * 14-day clock. Merged, not replaced, so unrelated fields on that doc survive.
 * Refuses a date in the past without `--force`.
 *
 * **stamp** — the T0 run. Starts every unstarted trial clock and writes away
 * the last of the beta tier ambiguity:
 *   - every `customers/{uid}` with `trialEndsAt: null` and no `subscriptionId`
 *     gets `trialEndsAt = goLiveAt + TRIAL_LENGTH_DAYS` and a recomputed
 *     `billingState`. Docs with a live clock or a subscription are untouched.
 *   - every `sites/{siteId}` with no explicit `tier` gets `tier: 'pro'`.
 *     `tierUpgradedAt` is deliberately NOT written: this is not an upgrade,
 *     it is recording the tier the site already had through the beta fallback.
 *
 * **status** — read-only. The pre-flight before `stamp` and the verification
 * after it. Prints the stored `goLiveAt`, the null-clock / live-clock /
 * subscribed customer split, the unstamped site count, and any account that is
 * missing a customers doc.
 *
 * ## the full T0 sequence (this script is the announce, stamp, and status steps)
 *
 *   T-30  `announce --golive=<T0>` + the 5.1 mass email to account owners.
 *   T-1   `node scripts/backfill-customers.mjs --env=<env>` then
 *         `node scripts/backfill-stripe-customers.mjs --env=<env>`. Take the
 *         backup snapshot of the `customers` and `sites` collections here.
 *   T0    5.2 — flip the Stripe env vars from test to live keys, smoke test a
 *         real $1 charge + refund, verify all three meters exist in live mode.
 *   T0    `stamp --env=<env> --dry-run`, read the plan, then `stamp --env=<env>`.
 *   T0    deploy the `billing-golive-copy` branch. It must carry, in the SAME
 *         deploy, the read-path cleanups this stamp makes safe:
 *           - delete `BETA_DEFAULT_TIER` and `getSiteTier()`'s fallback arm in
 *             `web/lib/siteTier.ts`
 *           - delete the hand-mirrored `BETA_DEFAULT_TIER` and
 *             `resolveSiteTier()`'s fallback arm in
 *             `functions/src/lib/quotaLogic.ts`
 *           - the 5.4 marketing copy flip ("free during beta" → real prices +
 *             "free 14-day trial"), including the pinned e2e specs
 *             (`hero.spec.ts`, `pricing.spec.ts`) that gate the deploy.
 *   T0+   `status --env=<env>` to confirm zero null clocks and zero unstamped
 *         sites.
 *
 * **Ordering is load-bearing.** The constant deletions must land AFTER this
 * script has run, never before: until every site doc carries an explicit tier,
 * an unstamped doc depends on that fallback to keep behaving like the pro-tier
 * site it has been all through the beta. Deleting it first silently downgrades
 * every legacy site. This script does not touch either file — that deletion
 * belongs to the deploy, not to the data migration.
 *
 * ## what this script does not do
 *
 * It sends no email. The go-live announcement is 5.1's mass send, and the
 * per-account reminders (day 10, day 13, expiry) are picked up automatically
 * by the trial-lifecycle cron once the clocks this script writes are live.
 *
 * Idempotent: a second `stamp` run plans zero writes, because the writes it
 * makes are exactly the conditions its own skip rules test for.
 *
 * Credentials:
 *   Reads FIREBASE_PROJECT_ID_{DEV|PROD}, FIREBASE_CLIENT_EMAIL_{DEV|PROD},
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD} from the environment. Falls back to plain
 *   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (the
 *   web/.env.local vars) if the env-specific ones aren't set — the fallback
 *   targets whatever project web/.env.local is pointed at, so verify before
 *   running live against prod.
 *
 *   web/.env.local, .claude/.env.local, and scripts/.env.local are auto-loaded
 *   if present. No Stripe key is needed: nothing here touches Stripe.
 *
 * ## structure
 *
 * Everything above `main()` is pure: no Firestore, no clock of its own, no
 * process state. The planning functions take plain `{ id, data }` arrays and
 * return the writes they would make, which is what
 * `web/__tests__/scripts/billingGoLive.test.ts` exercises. Module scope has no
 * side effects and `main()` only runs when this file is the entry point, so
 * importing it is safe.
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import readline from 'readline';

// Named `SCRIPT_DIR` rather than the sibling scripts' `__dirname`: the unit
// tests import this file, and under jest's CJS module wrapper a local
// `__dirname` collides with the one the wrapper already injects.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');

/**
 * Free-trial length, in days.
 *
 * Hand-mirror of `TRIAL_LENGTH_DAYS` in `web/lib/types/customer.ts`, which is
 * the source of truth — this file is ESM and can't import TypeScript. The two
 * must stay in sync: a drift here would hand the entire existing fleet a
 * different trial length than every signup after T0 gets.
 */
export const TRIAL_LENGTH_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Tier stamped onto a site doc that has none.
 *
 * `'pro'` because that is what such a site already resolves to today through
 * `BETA_DEFAULT_TIER` — the stamp records existing behaviour rather than
 * changing it, which is what makes deleting that fallback in the same deploy a
 * no-op for every customer.
 */
export const GO_LIVE_SITE_TIER = 'pro';

/** Firestore caps batches at 500. */
const BATCH_SIZE = 400;

/** Ids listed inline in dry-run / plan output before it collapses to a count. */
const SAMPLE_SIZE = 5;

// ---- Pure helpers -----------------------------------------------------------

/**
 * Epoch milliseconds out of any timestamp shape a Firestore read can produce,
 * or `null` when the value isn't readable as a time.
 *
 * Hand-mirror of `billingTimestampToMillis()` in
 * `web/lib/billing/billingState.ts`. Keep the accepted shapes in step.
 */
export function billingTimestampToMillis(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof ts === 'object' && ts !== null) {
    if (typeof ts.toMillis === 'function') {
      try {
        const ms = ts.toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  }
  return null;
}

/**
 * Trial end for a clock starting at `start`.
 *
 * Hand-mirror of `trialEndsAtFrom()` in `web/lib/types/customer.ts`, so a
 * beta account stamped here and a signup minted there land on the same
 * arithmetic.
 */
export function trialEndsAtFrom(start) {
  return new Date(start.getTime() + TRIAL_LENGTH_DAYS * MS_PER_DAY);
}

/**
 * Effective billing state for a customer doc.
 *
 * Hand-mirror of `resolveBillingState()` in `web/lib/billing/billingState.ts`
 * — read that file for why each arm is what it is. Reproduced rather than
 * approximated because `billingState` is a cached mirror of exactly that
 * function's output, and writing a value the resolver would not have produced
 * would make the cache lie.
 *
 * - `'active'` / `'past_due'` → `'active'` (Stripe's dunning owns recovery)
 * - `'canceled'` → `'canceled'`
 * - anything else (`'incomplete'`, `null`, unrecognised) → the trial clock
 * - `trialEndsAt` null or unparseable → `'trialing'` (fail open)
 * - `trialEndsAt` strictly in the future → `'trialing'`, else `'expired'`
 */
export function deriveBillingState(customer, now) {
  const status = customer?.subscriptionStatus;
  if (status === 'active' || status === 'past_due') return 'active';
  if (status === 'canceled') return 'canceled';

  const trialEndsAt = customer?.trialEndsAt;
  if (trialEndsAt == null) return 'trialing';

  const endsAtMs = billingTimestampToMillis(trialEndsAt);
  if (endsAtMs === null) return 'trialing';

  return endsAtMs > now.getTime() ? 'trialing' : 'expired';
}

/** True when the doc names a Stripe subscription, whatever its status. */
function hasSubscription(doc) {
  const id = doc?.subscriptionId;
  return typeof id === 'string' && id.length > 0;
}

/**
 * Validate the `--golive` argument.
 *
 * Returns `{ ok: true, date }`, or `{ ok: false, code, error, date? }` where
 * `code` is `'missing' | 'unparseable' | 'past'`. `date` is present on
 * `'past'` so `--force` can go ahead with it (backdating is a legitimate
 * repair when the announcement already happened and the doc was lost).
 *
 * A bare date (`2026-09-15`) is parsed as UTC midnight; a datetime without an
 * offset (`2026-09-15T17:00:00`) is parsed in the machine's local zone. Pass
 * an explicit offset so the instant doesn't depend on where it was run.
 */
export function parseGoLiveInput(raw, now) {
  if (raw === undefined || raw === true || raw === '') {
    return { ok: false, code: 'missing', error: '--golive=<ISO date> is required' };
  }

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      code: 'unparseable',
      error: `could not read "${raw}" as a date — use an ISO 8601 instant, e.g. 2026-09-15T17:00:00Z`,
    };
  }

  const date = new Date(ms);
  if (ms < now.getTime()) {
    return {
      ok: false,
      code: 'past',
      error: `${date.toISOString()} is in the past — announcing a go-live date that has already passed starts every new signup's clock immediately`,
      date,
    };
  }

  return { ok: true, date };
}

/**
 * Prerequisites for the T0 stamp, evaluated against plain data.
 *
 * Blockers, each `{ code, message, ... }`:
 * - `missing_customers` — a live `users/{uid}` with no `customers/{uid}` doc.
 *   Nothing can stamp a clock onto a doc that doesn't exist, and such an
 *   account fails open to `trialing` forever, so it would silently sit outside
 *   the whole billing lifecycle. Soft-deleted users are exempt:
 *   `backfill-customers.mjs` skips them on purpose (no live session, no fleet
 *   to bill), so their absence is expected rather than a gap.
 * - `golive_unset` — `config/billing.goLiveAt` is absent. The announce step
 *   has not run, which means no customer was ever told a date.
 * - `golive_future` — the announced instant hasn't arrived. Stamping early
 *   would start clocks before the date customers were given.
 *
 * The boundary is `<=`, matching `trialClockStarted()` in
 * `bootstrapUser.server.ts`: `goLiveAt` exactly equal to now has passed, so a
 * run at precisely T0 is allowed. Anything else would make the two disagree
 * about whether go-live has happened.
 *
 * Reporting only — the caller decides whether `--force` overrides them.
 */
export function checkStampPrereqs({ users = [], customerIds = [], goLiveAtMs = null, now }) {
  const existing = customerIds instanceof Set ? customerIds : new Set(customerIds);
  const blockers = [];

  const missingCustomerUids = [];
  for (const { id, data } of users) {
    if ((data ?? {}).deletedAt != null) continue;
    if (!existing.has(id)) missingCustomerUids.push(id);
  }

  if (missingCustomerUids.length > 0) {
    blockers.push({
      code: 'missing_customers',
      count: missingCustomerUids.length,
      sample: missingCustomerUids.slice(0, SAMPLE_SIZE),
      message:
        `${missingCustomerUids.length} live account(s) have no customers/{uid} doc — ` +
        `run: node scripts/backfill-customers.mjs --env=<env>`,
    });
  }

  if (goLiveAtMs === null) {
    blockers.push({
      code: 'golive_unset',
      message:
        'config/billing.goLiveAt is not set — run the announce step (task 5.1) first: ' +
        'node scripts/billing-go-live.mjs announce --env=<env> --golive=<ISO date>',
    });
  } else if (goLiveAtMs > now.getTime()) {
    blockers.push({
      code: 'golive_future',
      goLiveAtMs,
      message:
        `config/billing.goLiveAt (${new Date(goLiveAtMs).toISOString()}) has not passed yet — ` +
        `it is currently ${now.toISOString()}`,
    });
  }

  return { ok: blockers.length === 0, blockers, missingCustomerUids };
}

/**
 * Plan the `customers/{uid}` writes for the T0 stamp.
 *
 * Skips, in order:
 * - a doc naming a `subscriptionId` — Stripe is authoritative for that account
 *   and it never needed a trial clock. Checked before the clock so a converted
 *   account that still carries the null sentinel is left to its subscription
 *   rather than handed a trial it isn't on.
 * - a doc whose `trialEndsAt` is already set — either a post-T0 signup that
 *   self-started, an admin extension, or this script's own previous run. This
 *   is the idempotency hinge: the field this writes is the field it skips on.
 *
 * The clock is anchored on `goLiveAt`, not on `now`, so every account gets the
 * identical end instant no matter when the operator actually ran the script —
 * and so a run delayed past `goLiveAt + 14d` produces `'expired'` rather than
 * quietly extending everyone. That case is counted as `wouldExpire` and warned
 * about loudly; it is a real possibility if go-live slips and nobody moves the
 * announced date.
 */
export function planCustomerStamps(customers, { goLiveAt, now }) {
  const trialEndsAt = trialEndsAtFrom(goLiveAt);
  const writes = [];
  const totals = {
    total: customers.length,
    stamp: 0,
    alreadyLive: 0,
    subscribed: 0,
    wouldExpire: 0,
  };

  for (const { id, data } of customers) {
    const doc = data ?? {};

    if (hasSubscription(doc)) {
      totals.subscribed++;
      continue;
    }
    if (doc.trialEndsAt != null) {
      totals.alreadyLive++;
      continue;
    }

    const billingState = deriveBillingState(
      { subscriptionStatus: doc.subscriptionStatus, trialEndsAt },
      now,
    );
    if (billingState === 'expired') totals.wouldExpire++;

    writes.push({ uid: id, trialEndsAt, billingState });
    totals.stamp++;
  }

  return { writes, totals, trialEndsAt };
}

/**
 * Plan the `sites/{siteId}` writes for the T0 stamp.
 *
 * Compares the **raw stored field**, never `getSiteTier()`'s resolved value —
 * the same rule `stampSiteTiers()` in `web/lib/billing/stripeMirror.ts`
 * follows. A resolved comparison would read every unstamped doc as `'pro'`
 * already and plan nothing, leaving the whole fleet dependent on the fallback
 * this stamp exists to make deletable.
 *
 * An unrecognised value (`'gold'`, a number, …) is stamped too: it resolves to
 * `'pro'` through the same fallback today, so overwriting it with `'pro'`
 * preserves that site's behaviour past the deletion. Those are counted
 * separately because a tier field holding something other than `'core'` or
 * `'pro'` is a data anomaly worth eyeballing before the run.
 *
 * `tierUpgradedAt` is left alone. This is not an upgrade — it records the tier
 * the site has had all along — and stamping a date would misreport every
 * legacy site as having converted at T0.
 */
export function planSiteStamps(sites) {
  const writes = [];
  const totals = { total: sites.length, stamp: 0, alreadyStamped: 0, unknownTier: 0 };

  for (const { id, data } of sites) {
    const raw = (data ?? {}).tier;

    if (raw === 'core' || raw === 'pro') {
      totals.alreadyStamped++;
      continue;
    }
    if (raw != null) totals.unknownTier++;

    writes.push({ siteId: id, tier: GO_LIVE_SITE_TIER });
    totals.stamp++;
  }

  return { writes, totals };
}

/**
 * The read-only `status` report, computed from plain data.
 *
 * The customer split is exclusive and ordered subscribed → null-clock →
 * live-clock, so the three always sum to the collection size. `expired` is a
 * sub-count of `liveClock` (accounts whose clock has run out without
 * converting) rather than a fourth bucket.
 */
export function summarizeState({ users = [], customers = [], sites = [], goLiveAtMs = null, now }) {
  const prereqs = checkStampPrereqs({
    users,
    customerIds: customers.map((c) => c.id),
    goLiveAtMs,
    now,
  });

  const customerCounts = {
    total: customers.length,
    subscribed: 0,
    nullClock: 0,
    liveClock: 0,
    expired: 0,
  };

  for (const { data } of customers) {
    const doc = data ?? {};
    if (hasSubscription(doc)) {
      customerCounts.subscribed++;
      continue;
    }
    if (doc.trialEndsAt == null) {
      customerCounts.nullClock++;
      continue;
    }
    customerCounts.liveClock++;
    if (deriveBillingState(doc, now) === 'expired') customerCounts.expired++;
  }

  const siteCounts = { total: sites.length, stamped: 0, unstamped: 0 };
  for (const { data } of sites) {
    const raw = (data ?? {}).tier;
    if (raw === 'core' || raw === 'pro') siteCounts.stamped++;
    else siteCounts.unstamped++;
  }

  return {
    goLiveAtMs,
    goLiveHasPassed: goLiveAtMs !== null && goLiveAtMs <= now.getTime(),
    customers: customerCounts,
    sites: siteCounts,
    users: { total: users.length, missingCustomerDoc: prereqs.missingCustomerUids.length },
    prereqs,
    // A stamp run is worth doing while either collection still has work.
    stampPending: customerCounts.nullClock > 0 || siteCounts.unstamped > 0,
  };
}

/** `n days` / `in n days` phrasing for an instant relative to `now`. */
export function describeRelative(ms, now) {
  const deltaMs = ms - now.getTime();
  const days = Math.round(Math.abs(deltaMs) / MS_PER_DAY);
  const unit = days === 1 ? 'day' : 'days';
  if (deltaMs >= 0) return days === 0 ? 'today' : `in ${days} ${unit}`;
  return days === 0 ? 'today' : `${days} ${unit} ago`;
}

// ---- CLI plumbing -----------------------------------------------------------

const MODES = ['announce', 'stamp', 'status'];

const USAGE = `Usage: node scripts/billing-go-live.mjs <${MODES.join('|')}> --env=dev|prod [options]

  announce --golive=<ISO date>   write config/billing { goLiveAt } (task 5.1, T-30)
  stamp                          start every unstarted trial clock + stamp site tiers (task 5.3, T0)
  status                         read-only report — run before and after stamp

Options:
  --env=dev|prod                 which firebase project to target (required)
  --golive=<ISO date>            announce only; use an explicit offset, e.g. 2026-09-15T17:00:00Z
  --dry-run                      plan the writes and print them, change nothing
  --force                        override the refusals (past date / prereqs) — read the warning first`;

function getFlag(args, name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

/**
 * Resolve service-account credentials for `env`. Same precedence and same
 * fallback warning as the backfill scripts. The private key is never printed.
 */
function resolveCredentials(env) {
  loadEnvFile(join(ROOT, 'web', '.env.local'));
  loadEnvFile(join(ROOT, '.claude', '.env.local'));
  loadEnvFile(join(ROOT, 'scripts', '.env.local'));

  const suffix = env === 'prod' ? '_PROD' : '_DEV';
  const projectId =
    process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
  const clientEmail =
    process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey =
    process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error(`❌ Missing Firebase credentials for env=${env}.`);
    console.error(`   Set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
    console.error(`   and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed equivalents).`);
    process.exit(1);
  }

  if (!process.env[`FIREBASE_PROJECT_ID${suffix}`]) {
    console.warn(
      `⚠️  No FIREBASE_PROJECT_ID${suffix} set — falling back to plain FIREBASE_PROJECT_ID (${projectId}).`
    );
    console.warn(`   Verify this matches the intended ${env} project before continuing.\n`);
  }

  return { projectId, clientEmail, privateKey: rawPrivateKey.replace(/\\n/g, '\n') };
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/** `firebase-admin` lives in web/node_modules — resolve it from there. */
function loadFirestore({ projectId, clientEmail, privateKey }) {
  const require = createRequire(join(ROOT, 'web', 'package.json'));
  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  return admin.firestore();
}

/** `{ id, data }` pairs — the shape every planning function above consumes. */
async function readCollection(db, name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

async function readGoLiveAtMs(db) {
  const snap = await db.collection('config').doc('billing').get();
  if (!snap.exists) return null;
  return billingTimestampToMillis((snap.data() ?? {}).goLiveAt);
}

function formatSample(ids) {
  if (ids.length === 0) return '';
  const shown = ids.slice(0, SAMPLE_SIZE).join(', ');
  return ids.length > SAMPLE_SIZE ? `${shown}, … (+${ids.length - SAMPLE_SIZE} more)` : shown;
}

/**
 * Commit one batch of `update()` writes.
 *
 * `update`, not `set`: every target was read moments ago, so a missing doc
 * means it was deleted mid-run and must fail rather than be resurrected as a
 * partial. A batch fails whole, so fall back to per-doc updates and let only
 * the genuinely broken ones drop out. Returns `{ written, failed }`.
 */
async function commitUpdates(db, pending) {
  const batch = db.batch();
  for (const { ref, data } of pending) batch.update(ref, data);

  try {
    await batch.commit();
    return { written: pending.length, failed: 0 };
  } catch (err) {
    console.warn(`  ⚠️  batch commit failed (${err.message}) — retrying per-doc`);
    let written = 0;
    let failed = 0;
    for (const { ref, data } of pending) {
      try {
        await ref.update(data);
        written++;
      } catch (docErr) {
        console.error(`  ❌ ${ref.path}: ${docErr.message}`);
        failed++;
      }
    }
    return { written, failed };
  }
}

/** Batch `writes` (already `{ ref, data }`) through `commitUpdates`. */
async function applyWrites(db, writes, label) {
  const result = { written: 0, failed: 0 };
  let pending = [];

  for (const write of writes) {
    pending.push(write);
    if (pending.length >= BATCH_SIZE) {
      const batchResult = await commitUpdates(db, pending);
      result.written += batchResult.written;
      result.failed += batchResult.failed;
      console.log(`  [${label}] ${result.written + result.failed}/${writes.length} …`);
      pending = [];
    }
  }

  if (pending.length > 0) {
    const batchResult = await commitUpdates(db, pending);
    result.written += batchResult.written;
    result.failed += batchResult.failed;
  }

  return result;
}

// ---- Modes ------------------------------------------------------------------

async function runAnnounce(db, { projectId, env, dryRun, force, goliveArg, now }) {
  const parsed = parseGoLiveInput(goliveArg, now);

  if (!parsed.ok && !(parsed.code === 'past' && force)) {
    console.error(`❌ ${parsed.error}`);
    if (parsed.code === 'past') console.error('   Re-run with --force if that is deliberate.');
    process.exit(1);
  }

  const goLiveAt = parsed.date;
  const storedMs = await readGoLiveAtMs(db);

  console.log(`  stored goLiveAt : ${
    storedMs === null
      ? '(not set)'
      : `${new Date(storedMs).toISOString()} (${describeRelative(storedMs, now)})`
  }`);
  console.log(`  new goLiveAt    : ${goLiveAt.toISOString()} (${describeRelative(goLiveAt.getTime(), now)})`);

  if (storedMs !== null && storedMs <= now.getTime() && goLiveAt.getTime() > now.getTime()) {
    console.warn(
      `\n⚠️  The stored go-live date has already passed and you are moving it into the future.`
    );
    console.warn(
      `   That re-arms the bootstrap clock gate: new signups would go back to minting the`
    );
    console.warn(`   trialEndsAt: null sentinel until the new date arrives.`);
  }

  if (dryRun) {
    console.log(`\nDry run complete — no writes made. Re-run without --dry-run to apply.`);
    return;
  }

  if (env === 'prod') {
    const confirmed = await promptYesNo(
      `\n⚠️  About to write config/billing to PRODUCTION (${projectId}). Continue? [y/N] `
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // merge:true — `config/billing` is a shared deployment-wide doc; a future
  // field on it must survive an announce.
  await db.collection('config').doc('billing').set({ goLiveAt }, { merge: true });

  console.log(`\n✅ config/billing.goLiveAt = ${goLiveAt.toISOString()}`);
  console.log(`   The dashboard announcement banner is now live.`);
  console.log(`   Signups from that instant self-start their ${TRIAL_LENGTH_DAYS}-day clock;`);
  console.log(`   everyone minted before it is stamped by \`stamp\` at T0.`);
}

async function runStamp(db, { projectId, env, dryRun, force, now }) {
  const [users, customers, sites, goLiveAtMs] = await Promise.all([
    readCollection(db, 'users'),
    readCollection(db, 'customers'),
    readCollection(db, 'sites'),
    readGoLiveAtMs(db),
  ]);

  const prereqs = checkStampPrereqs({
    users,
    customerIds: customers.map((c) => c.id),
    goLiveAtMs,
    now,
  });

  if (!prereqs.ok) {
    for (const blocker of prereqs.blockers) {
      console.error(`${force ? '⚠️  [forced past]' : '❌'} ${blocker.message}`);
      if (blocker.sample?.length) console.error(`   e.g. ${formatSample(blocker.sample)}`);
    }
    if (!force) {
      console.error(`\nRefusing to stamp. Fix the above, or re-run with --force if deliberate.`);
      process.exit(1);
    }
    console.warn('');
  }

  // With --force past a `golive_unset` blocker there is no announced instant to
  // anchor on, so fall back to now: the operator has asserted that go-live is
  // happening at the moment they ran this.
  const goLiveAt = goLiveAtMs === null ? now : new Date(goLiveAtMs);
  if (goLiveAtMs === null) {
    console.warn(`⚠️  No announced go-live date — anchoring every clock on now (${now.toISOString()}).\n`);
  }

  const customerPlan = planCustomerStamps(customers, { goLiveAt, now });
  const sitePlan = planSiteStamps(sites);

  console.log(`  goLiveAt        : ${goLiveAt.toISOString()}`);
  console.log(
    `  trialEndsAt     : ${customerPlan.trialEndsAt.toISOString()} (goLiveAt + ${TRIAL_LENGTH_DAYS}d)`
  );
  console.log(`\ncustomers (${customerPlan.totals.total} docs)`);
  console.log(`  planned            : ${customerPlan.totals.stamp}`);
  console.log(`  clock already live : ${customerPlan.totals.alreadyLive} (untouched)`);
  console.log(`  subscribed         : ${customerPlan.totals.subscribed} (untouched)`);
  if (customerPlan.writes.length > 0) {
    console.log(`  sample             : ${formatSample(customerPlan.writes.map((w) => w.uid))}`);
  }

  console.log(`\nsites (${sitePlan.totals.total} docs)`);
  console.log(`  planned            : ${sitePlan.totals.stamp} → tier: '${GO_LIVE_SITE_TIER}'`);
  console.log(`  tier already set   : ${sitePlan.totals.alreadyStamped} (untouched)`);
  if (sitePlan.totals.unknownTier > 0) {
    console.log(`  unrecognised tier  : ${sitePlan.totals.unknownTier} (resolved '${GO_LIVE_SITE_TIER}' today — restamped)`);
  }
  if (sitePlan.writes.length > 0) {
    console.log(`  sample             : ${formatSample(sitePlan.writes.map((w) => w.siteId))}`);
  }

  if (customerPlan.totals.wouldExpire > 0) {
    console.warn(
      `\n⚠️  ${customerPlan.totals.wouldExpire} account(s) would be stamped straight into 'expired':`
    );
    console.warn(
      `   goLiveAt + ${TRIAL_LENGTH_DAYS}d is already in the past. Those accounts lock out the moment`
    );
    console.warn(
      `   this runs. If go-live slipped, re-announce a current date before stamping.`
    );
  }

  if (customerPlan.totals.stamp === 0 && sitePlan.totals.stamp === 0) {
    console.log(`\nNothing to stamp — every clock is live and every site carries a tier.`);
    return;
  }

  if (dryRun) {
    console.log(`\nTotals:`);
    console.log(`  Would stamp customers : ${customerPlan.totals.stamp}`);
    console.log(`  Would stamp sites     : ${sitePlan.totals.stamp}`);
    console.log(`\nDry run complete — no writes made. Re-run without --dry-run to apply.`);
    return;
  }

  if (env === 'prod') {
    const confirmed = await promptYesNo(
      `\n⚠️  About to write ${customerPlan.totals.stamp} customer + ${sitePlan.totals.stamp} site doc(s) ` +
        `to PRODUCTION (${projectId}). Continue? [y/N] `
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  console.log('');
  const customerResult = await applyWrites(
    db,
    customerPlan.writes.map((write) => ({
      ref: db.collection('customers').doc(write.uid),
      data: { trialEndsAt: write.trialEndsAt, billingState: write.billingState },
    })),
    'customers'
  );
  const siteResult = await applyWrites(
    db,
    sitePlan.writes.map((write) => ({
      ref: db.collection('sites').doc(write.siteId),
      // `tierUpgradedAt` is deliberately not written — see planSiteStamps().
      data: { tier: write.tier },
    })),
    'sites'
  );

  const failed = customerResult.failed + siteResult.failed;

  console.log(`\nTotals:`);
  console.log(`  Customers stamped : ${customerResult.written} / ${customerPlan.totals.stamp}`);
  console.log(`  Sites stamped     : ${siteResult.written} / ${sitePlan.totals.stamp}`);
  console.log(`  Failed            : ${failed}`);

  if (failed > 0) {
    console.log(`\n⚠️  Finished with ${failed} failure(s) — re-run to retry (the run is idempotent).`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Stamp complete. Next: deploy the \`billing-golive-copy\` branch (the`);
  console.log(`   BETA_DEFAULT_TIER deletions + the 5.4 copy flip), then re-run \`status\`.`);
}

async function runStatus(db, { projectId, env, now }) {
  const [users, customers, sites, goLiveAtMs] = await Promise.all([
    readCollection(db, 'users'),
    readCollection(db, 'customers'),
    readCollection(db, 'sites'),
    readGoLiveAtMs(db),
  ]);

  const report = summarizeState({ users, customers, sites, goLiveAtMs, now });

  console.log(`  env             : ${env} (${projectId})`);
  console.log(`  now             : ${now.toISOString()}`);
  console.log(
    `  goLiveAt        : ${
      report.goLiveAtMs === null
        ? '(not set — announce has not run)'
        : `${new Date(report.goLiveAtMs).toISOString()} (${describeRelative(report.goLiveAtMs, now)}, ${
            report.goLiveHasPassed ? 'passed' : 'pending'
          })`
    }`
  );

  console.log(`\ncustomers (${report.customers.total} docs)`);
  console.log(`  null clock      : ${report.customers.nullClock} (pre-go-live sentinel — stamp targets these)`);
  console.log(`  live clock      : ${report.customers.liveClock}`);
  console.log(`    of which expired: ${report.customers.expired}`);
  console.log(`  subscribed      : ${report.customers.subscribed}`);

  console.log(`\nsites (${report.sites.total} docs)`);
  console.log(`  explicit tier   : ${report.sites.stamped}`);
  console.log(`  unstamped       : ${report.sites.unstamped} (still relying on BETA_DEFAULT_TIER)`);

  console.log(`\nusers (${report.users.total} docs)`);
  console.log(`  no customers doc: ${report.users.missingCustomerDoc}`);
  if (report.prereqs.missingCustomerUids.length > 0) {
    console.log(`  e.g. ${formatSample(report.prereqs.missingCustomerUids)}`);
  }

  console.log(`\nstamp readiness`);
  if (report.prereqs.ok) {
    console.log(`  ✅ prerequisites met`);
  } else {
    for (const blocker of report.prereqs.blockers) console.log(`  ❌ ${blocker.message}`);
  }
  console.log(
    report.stampPending
      ? `  work remaining  : ${report.customers.nullClock} clock(s), ${report.sites.unstamped} site(s)`
      : `  work remaining  : none — stamp would be a no-op`
  );

  if (!report.stampPending && report.sites.unstamped === 0) {
    console.log(
      `\n  Safe to delete BETA_DEFAULT_TIER (web/lib/siteTier.ts + functions/src/lib/quotaLogic.ts).`
    );
  }
}

// ---- Entry point ------------------------------------------------------------

async function main(argv) {
  const mode = argv[0];
  const args = argv.slice(1);

  if (!MODES.includes(mode)) {
    console.error(USAGE);
    process.exit(1);
  }

  const env = getFlag(args, 'env');
  if (env !== 'dev' && env !== 'prod') {
    console.error(USAGE);
    process.exit(1);
  }

  const dryRun = getFlag(args, 'dry-run') === true;
  const force = getFlag(args, 'force') === true;
  const goliveArg = getFlag(args, 'golive');
  const now = new Date();

  const credentials = resolveCredentials(env);
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}billing go-live (${mode}) — env=${env}, project=${credentials.projectId}\n`
  );

  const db = loadFirestore(credentials);

  if (mode === 'announce') {
    await runAnnounce(db, { projectId: credentials.projectId, env, dryRun, force, goliveArg, now });
  } else if (mode === 'stamp') {
    await runStamp(db, { projectId: credentials.projectId, env, dryRun, force, now });
  } else {
    await runStatus(db, { projectId: credentials.projectId, env, now });
  }
}

// Only run when invoked as a script — importing this file (the unit tests do)
// must not parse argv, read credentials, or touch Firestore.
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPoint === import.meta.url) {
  main(process.argv.slice(2))
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error('\n❌ billing-go-live failed:', err);
      process.exit(1);
    });
}
