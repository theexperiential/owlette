#!/usr/bin/env node
/**
 * mfaFactors Inventory Backfill
 *
 * Installs the denormalized second-factor inventory that the universal-2FA
 * work introduces:
 *
 *   users/{uid}.mfaFactors  = { totp: boolean, passkeys: number }
 *   users/{uid}.mfaEnrolled = mfaFactors.totp || mfaFactors.passkeys > 0
 *
 * `mfaEnrolled` has always meant "has TOTP" — it is the only factor that has
 * ever set it — so the legacy boolean IS the `totp` leg, and the `passkeys`
 * leg is recovered by counting the `users/{uid}/passkeys` subcollection.
 * Without this backfill, every pre-existing passkey user stays outside the
 * inventory and the headline behavior (a passkey counts as a second factor)
 * never activates for them.
 *
 * Two modes, because the two writes carry very different risk:
 *
 *   --mode=inventory-only   DEFAULT. Writes `mfaFactors` only. Never touches
 *                           `mfaEnrolled` or `requiresMfaSetup`, so it cannot
 *                           change who is challenged at login. Safe to run at
 *                           any point in the rollout.
 *   --mode=full             Also derives `mfaEnrolled` from the inventory,
 *                           which flips a passkey-only user from false to
 *                           true. ONLY run this once the /verify-2fa passkey
 *                           challenge has shipped to the target environment —
 *                           flipping it earlier means "MFA required" with
 *                           nothing the user can present. That is a lockout.
 *
 * `--mode=full` is deliberately promote-only and recovery-gated:
 *
 *   - It never demotes. A user whose stored `mfaEnrolled` is true but whose
 *     inventory derives false is an anomaly, not a downgrade candidate: the
 *     script skips them and reports so an operator can look, rather than
 *     silently removing an MFA requirement.
 *   - It SKIPS any user it would flip to true whose `backupCodes` array is
 *     empty. Marking an account "has 2FA" before it has any recovery path is
 *     the single biggest operational risk in this plan — one lost device and
 *     the account is gone. Those uids are listed in the log with the reason.
 *   - When it does promote, it clears `requiresMfaSetup` in the same write.
 *     `web/lib/mfaFactors.server.ts` owns that field in both directions for
 *     exactly this reason: leaving the nag set on an account that provably
 *     has a factor bounces the user to /setup-2fa forever
 *     (web/app/dashboard/page.tsx:836-841). It never SETS the nag — re-arming
 *     mandatory setup is a user-visible decision that belongs to the runtime
 *     module, not to a bulk migration.
 *
 * Usage:
 *   node scripts/backfill-mfa-factors.mjs --project owlette-dev-3838a
 *   node scripts/backfill-mfa-factors.mjs --project owlette-dev-3838a --commit
 *   node scripts/backfill-mfa-factors.mjs --project owlette-prod-90a12 --mode=full --commit \
 *        --confirm-project=owlette-prod-90a12
 *
 * DRY RUN IS THE DEFAULT — nothing is written without an explicit `--commit`.
 *
 * Every run (dry or live) writes a machine-readable log to
 * `scripts/backfill-mfa-factors.<projectId>.log.json` recording per-outcome
 * counts, every skipped uid with its reason, and the prior value of each
 * field this script would change. That last part is what makes a manual
 * reversal possible: unlike the arrayUnion in
 * `backfill-site-owner-membership.mjs`, these are scalar overwrites, so the
 * pre-image is the only record of what was there before.
 *
 * Credentials:
 *   Reads FIREBASE_PROJECT_ID_{DEV|PROD}, FIREBASE_CLIENT_EMAIL_{DEV|PROD},
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD} from the environment, falling back to the
 *   unsuffixed web/.env.local vars. dev and prod are SEPARATE Firebase
 *   projects; unlike the env-flag scripts, this one is handed the exact
 *   project id, so a resolved project that does not match --project is a hard
 *   error rather than a warning.
 *
 *   web/.env.local, .claude/.env.local, and scripts/.env.local are auto-loaded
 *   if present.
 *
 * Firestore rules: no rule change is required for this backfill — see the
 * `rulesReview` block near the bottom of this file, which is also embedded in
 * every log.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// firebase-admin lives in web/node_modules — resolve it from there so the
// script runs without a root-level dependency on it.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const admin = require('firebase-admin');

// ---- CLI parsing ------------------------------------------------------------

const args = process.argv.slice(2);

/** Flags that take a value, as `--flag=value` or `--flag value`. */
const VALUE_FLAGS = new Set(['project', 'mode', 'log-file', 'confirm-project']);
/** Flags that take no value (a bare `--flag`, or an explicit true/false). */
const BOOLEAN_FLAGS = new Set(['commit', 'dry-run']);

/**
 * Parse argv into a flag map, rejecting anything unrecognised. A typo like
 * `--dryrun` or `--comit` must never parse as "flag not requested" and fall
 * through to the other branch — for `--commit` that branch writes.
 */
function parseArgs() {
  const parsed = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      console.error(`❌ unexpected argument: ${arg}`);
      usage();
      process.exit(2);
    }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        // Space-separated form. The next token is the value only if it is not
        // itself a flag; `--mode --commit` must not swallow `--commit`.
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value === '') {
        console.error(`❌ --${name} requires a value (--${name}=<value> or --${name} <value>).`);
        usage();
        process.exit(2);
      }
      parsed.set(name, value);
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      // `getFlag`-style parsing returns the string after `=`, so a bare
      // `=== true` check silently treats the natural `--commit=true` as OFF.
      // Accept the bare form, accept explicit true/false, refuse the rest.
      if (inlineValue === undefined || inlineValue === 'true' || inlineValue === '1') {
        parsed.set(name, true);
      } else if (inlineValue === 'false' || inlineValue === '0') {
        parsed.set(name, false);
      } else {
        console.error(`❌ --${name} expects no value or true/false, got: ${inlineValue}`);
        process.exit(2);
      }
      continue;
    }

    console.error(`❌ unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  return parsed;
}

function usage() {
  console.error(
    '\nUsage: node scripts/backfill-mfa-factors.mjs --project <projectId> [--mode=inventory-only|full] [--commit]\n' +
      `       projects: ${[...PROJECT_ENVS.keys()].join(', ')}\n` +
      '       --mode      inventory-only (default) writes mfaFactors only;\n' +
      '                   full also derives mfaEnrolled (lockout risk — read the header).\n' +
      '       --commit    perform the writes. Without it this is a DRY RUN.\n' +
      '       --dry-run   explicit no-op affirmation of the default; refuses to combine with --commit.\n' +
      '       --log-file  override the log path (default scripts/backfill-mfa-factors.<projectId>.log.json)\n' +
      '       --confirm-project=<projectId>  non-interactive confirmation for protected projects\n'
  );
}

/**
 * The only project ids this script will target, mapped to the credential
 * suffix that addresses them. An allowlist rather than a free-form string:
 * a mistyped project id must fail loudly, not authenticate somewhere
 * unexpected via the unsuffixed fallback credentials.
 */
const PROJECT_ENVS = new Map([
  ['owlette-dev-3838a', 'dev'],
  ['owlette-prod-90a12', 'prod'],
]);

/** Modes, and whether the mode is permitted to touch `mfaEnrolled`. */
const MODES = new Set(['inventory-only', 'full']);

const flags = parseArgs();

const requestedProject = flags.get('project');
if (!requestedProject) {
  console.error('❌ --project is required.');
  usage();
  process.exit(1);
}
if (!PROJECT_ENVS.has(requestedProject)) {
  console.error(`❌ unknown project: ${requestedProject}`);
  console.error(`   known projects: ${[...PROJECT_ENVS.keys()].join(', ')}`);
  process.exit(1);
}
const env = PROJECT_ENVS.get(requestedProject);

// An absent --mode means the safe default. A PRESENT but unrecognised one is
// rejected: `--mode=inventory` or `--mode=Full` must not silently fall back to
// the default and produce a run the operator did not ask for.
const mode = flags.has('mode') ? flags.get('mode') : 'inventory-only';
if (!MODES.has(mode)) {
  console.error(`❌ unknown --mode: ${mode}`);
  console.error(`   valid modes: ${[...MODES].join(', ')}`);
  process.exit(2);
}

const commit = flags.get('commit') === true;
const explicitDryRun = flags.get('dry-run') === true;
if (commit && explicitDryRun) {
  console.error('❌ --commit and --dry-run are mutually exclusive.');
  process.exit(2);
}
const dryRun = !commit;

const logFileArg = flags.get('log-file');
const confirmProject = flags.get('confirm-project');

// ---- .env loading -----------------------------------------------------------

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

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

// ---- Credentials ------------------------------------------------------------

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId =
  process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey =
  process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`❌ missing Firebase credentials for ${requestedProject} (env=${env}).`);
  console.error(`   set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
  console.error(`   and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed equivalents).`);
  process.exit(1);
}

// The caller named the project explicitly, so a mismatch between what they
// asked for and what the resolved credentials actually address is a hard
// error. The env-flag scripts can only warn here; this one can be certain.
if (projectId !== requestedProject) {
  console.error(
    `❌ credential mismatch: --project ${requestedProject} but the resolved credentials ` +
      `point at ${projectId}.`
  );
  console.error(
    `   set FIREBASE_PROJECT_ID${suffix}/FIREBASE_CLIENT_EMAIL${suffix}/FIREBASE_PRIVATE_KEY${suffix}` +
      ' for the intended project, or run against the project those credentials belong to.'
  );
  process.exit(1);
}

const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

// ---- Backfill ---------------------------------------------------------------

/** Firestore caps a write batch at 500 operations. */
const BATCH_LIMIT = 400;

/** Page size for the users scan, so a large collection is never held twice. */
const SCAN_PAGE_SIZE = 500;

/** How many passkey subcollection counts to run at once. */
const COUNT_CONCURRENCY = 25;

/**
 * Projects that require a typed confirmation regardless of the --project
 * flag. Gating on the flag alone trusts an argument; this gates on the
 * project the credentials actually resolved to.
 */
const PROTECTED_PROJECT_IDS = new Set(['owlette-prod-90a12']);

/**
 * The Firestore rules review this task owes, embedded in every log so the
 * finding travels with the run rather than living only in a chat transcript.
 * Checked against firestore.rules at commit 07243fe.
 */
const rulesReview = {
  ruleChangeRequired: false,
  checked: [
    'firestore.rules:612-666 — match /users/{userId}: client read is self-or-superadmin; ' +
      'self-update is an allowlist (preferences, displayName, photoURL, timezone, lastSiteId, ' +
      'lastMachineIds) that excludes every MFA field; `allow write: if isServiceAccount()` is ' +
      'what permits this script (Admin SDK) to write mfaFactors/mfaEnrolled.',
    'firestore.rules:629-641 — allow create pins mfaEnrolled==false, requiresMfaSetup==true and ' +
      'passkeyEnrolled==false on self-bootstrap, using the absent-OR-equals pattern.',
    'firestore.rules — no match block exists for users/{userId}/passkeys/{credentialId}; the ' +
      'catch-all `match /{document=**} { allow read, write: if false; }` therefore denies all ' +
      'client access to it. Passkeys are Admin-SDK-only, which is why this script counts them ' +
      'server-side and no rule is needed to read them.',
  ],
  notes: [
    'mfaFactors is server-written only: the self-update allowlist does not include it, so no ' +
      'client can create or modify it after the user doc exists. The Admin SDK bypasses rules ' +
      'entirely, so this backfill needs no rule change to run.',
    'HARDENING (low, not required for this backfill, reported rather than applied because ' +
      'firestore.rules is a guarded file): the `allow create` clause at :629-641 pins ' +
      'mfaEnrolled/requiresMfaSetup/passkeyEnrolled but says nothing about mfaFactors. A ' +
      'signed-in user whose doc does not yet exist could self-create it with ' +
      "mfaFactors: { totp: true, passkeys: 0 } while mfaEnrolled stays pinned false. That is " +
      'not an MFA bypass — the session gate reads mfaEnrolled, and the enrollment gate reading ' +
      'a planted factor fails closed (it demands a challenge) rather than open. The reachable ' +
      'consequence is that the next mfaFactors.server.ts write inherits the planted totp leg ' +
      'and derives mfaEnrolled: true / requiresMfaSetup: false for an account with no real ' +
      'factor, i.e. an escape from mandatory-2FA nagging plus a self-inflicted lockout. ' +
      'Reachability is further narrowed by /api/users/bootstrap, which made user-doc creation ' +
      'server-mediated. Fix if desired: add ' +
      "`(!('mfaFactors' in request.resource.data) || request.resource.data.mfaFactors == " +
      "{'totp': false, 'passkeys': 0})` to the create clause.",
  ],
};

function promptYesNo(question) {
  return new Promise((resolve) => {
    // Non-interactive confirmation: the operator must name the exact project
    // being written to. Deliberate enough that it cannot be typed by accident
    // or inherited from a stale shell history against the wrong environment.
    if (confirmProject !== undefined) {
      if (confirmProject === projectId) {
        console.log(`${question}y  (--confirm-project=${confirmProject})`);
        resolve(true);
      } else {
        console.error(
          `\n❌ --confirm-project=${confirmProject} does not match the resolved project ${projectId}.`
        );
        resolve(false);
      }
      return;
    }
    if (!process.stdin.isTTY) {
      // readline's callback never fires on a non-TTY stdin, which would hang
      // or exit 0 having done nothing. Refuse explicitly instead.
      console.error(
        '\n❌ confirmation required but stdin is not a TTY.' +
          `\n   re-run interactively, or pass --confirm-project=${projectId}`
      );
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Mirror of `normalizeMfaFactors` in web/lib/mfaFactors.server.ts: validate
 * each leg independently, falling back per-leg rather than discarding the
 * whole map. Kept in sync by hand — a .mjs script cannot import the TS module.
 *
 * - `totp` falls back to the legacy `mfaEnrolled === true`, because TOTP is
 *   the only factor that has ever set that field. The presence of `mfaSecret`
 *   is deliberately NOT treated as enrollment: an in-flight setup keeps its
 *   secret in mfa_pending/{uid}.
 * - `passkeys` is always the real subcollection count here. A stored count is
 *   a cache; the backfill exists to install the truth, so it never trusts it.
 */
function desiredInventory(userData, passkeyCount) {
  const stored = userData?.mfaFactors;
  const storedTotp =
    stored && typeof stored === 'object' && typeof stored.totp === 'boolean'
      ? stored.totp
      : undefined;
  return {
    totp: storedTotp !== undefined ? storedTotp : userData?.mfaEnrolled === true,
    passkeys: Math.max(0, Math.trunc(passkeyCount)),
  };
}

function deriveMfaEnrolled(inv) {
  return inv.totp || inv.passkeys > 0;
}

function factorsEqual(stored, desired) {
  return (
    !!stored &&
    typeof stored === 'object' &&
    stored.totp === desired.totp &&
    stored.passkeys === desired.passkeys
  );
}

/** Count a user's passkeys with an aggregation query — no document reads. */
async function countPasskeys(db, uid) {
  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('passkeys')
    .count()
    .get();
  return snap.data().count;
}

/**
 * Projection of a pending change for the log. Email is printed to the console
 * for the operator's review but kept OUT of the log file: these logs get
 * committed (see the site-owner backfill), and a committed migration log is
 * not the place for a list of user addresses.
 */
function forLog({ uid, update, before }) {
  return { uid, update, before };
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Page through `users/*`, projecting only the fields this script reads. The
 * projection keeps the scan cheap on a large collection and guarantees the
 * script never pulls a secret it has no business holding (mfaSecret, in
 * particular, is not selected).
 */
async function scanUsers(db) {
  const users = [];
  let cursor = null;
  for (;;) {
    let query = db
      .collection('users')
      .select('email', 'mfaEnrolled', 'mfaFactors', 'backupCodes', 'deletedAt')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(SCAN_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) users.push({ uid: doc.id, data: doc.data() ?? {} });
    if (snap.size < SCAN_PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return users;
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}mfaFactors backfill — project=${projectId}, mode=${mode}\n`
  );
  if (mode === 'full') {
    console.log(
      '⚠️  --mode=full derives mfaEnrolled. Only run this once the /verify-2fa passkey\n' +
        '    challenge is live in this environment, or passkey-only users are locked out.\n'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
  const db = admin.firestore();

  const users = await scanUsers(db);
  console.log(`scanned ${users.length} user document(s)`);

  const counts = await mapWithConcurrency(users, COUNT_CONCURRENCY, async ({ uid }) => {
    try {
      return { count: await countPasskeys(db, uid) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  const toUpdate = [];
  const alreadyCorrect = [];
  const skipped = [];
  const errored = [];
  /** Users --mode=full WOULD promote, surfaced during inventory-only as a preview. */
  const promotionPreview = [];

  for (let i = 0; i < users.length; i++) {
    const { uid, data } = users[i];
    const counted = counts[i];
    if (counted.error !== undefined) {
      errored.push({ uid, stage: 'count-passkeys', error: counted.error });
      continue;
    }

    // The delete cascade tears these accounts down deliberately; re-stamping
    // MFA state onto them would partially reverse that.
    if (typeof data.deletedAt === 'number') {
      skipped.push({ uid, reason: 'soft-deleted' });
      continue;
    }

    const desired = desiredInventory(data, counted.count);
    const derived = deriveMfaEnrolled(desired);
    const storedEnrolled = data.mfaEnrolled === true;
    const hasBackupCodes = Array.isArray(data.backupCodes) && data.backupCodes.length > 0;

    const update = {};
    const before = {};
    if (!factorsEqual(data.mfaFactors, desired)) {
      update.mfaFactors = desired;
      before.mfaFactors = data.mfaFactors ?? null;
    }

    if (mode === 'full') {
      if (derived && !storedEnrolled) {
        if (!hasBackupCodes) {
          // The mandatory safety gate. Flipping the switch before the account
          // has any recovery path turns one lost device into a lost account.
          skipped.push({
            uid,
            reason: 'no-backup-codes',
            detail: 'would flip mfaEnrolled to true but backupCodes is empty',
            factors: desired,
          });
          continue;
        }
        update.mfaEnrolled = true;
        // Clear the nag in the same write — see the header. Never set it.
        update.requiresMfaSetup = false;
        before.mfaEnrolled = data.mfaEnrolled ?? null;
        promotionPreview.push({ uid, factors: desired });
      } else if (!derived && storedEnrolled) {
        // Promote-only: an account claiming enrollment with nothing in the
        // inventory is an anomaly for a human to look at, not something a
        // bulk migration should quietly downgrade.
        skipped.push({
          uid,
          reason: 'would-demote',
          detail: 'mfaEnrolled is true but the inventory derives false — not demoting',
          factors: desired,
        });
        continue;
      }
    } else if (derived && !storedEnrolled) {
      // inventory-only never writes mfaEnrolled, but the operator needs to
      // know the size of the --mode=full step before they take it.
      promotionPreview.push({ uid, factors: desired, hasBackupCodes });
    }

    if (Object.keys(update).length === 0) {
      alreadyCorrect.push({ uid });
      continue;
    }

    toUpdate.push({
      uid,
      email: typeof data.email === 'string' ? data.email : null,
      update,
      before,
    });
  }

  // ---- Blast radius, before any write ----
  console.log('\n--- blast radius ---');
  console.log(`  users scanned              : ${users.length}`);
  console.log(`  already correct            : ${alreadyCorrect.length}`);
  console.log(`  TO UPDATE                  : ${toUpdate.length}`);
  console.log(`  skipped                    : ${skipped.length}`);
  console.log(`  errored                    : ${errored.length}`);
  if (mode === 'inventory-only') {
    const withoutCodes = promotionPreview.filter((p) => !p.hasBackupCodes).length;
    console.log(`  --mode=full would promote  : ${promotionPreview.length}`);
    console.log(`    of those, no backup codes: ${withoutCodes}  (--mode=full would skip them)`);
  } else {
    console.log(`  mfaEnrolled promotions     : ${promotionPreview.length}`);
  }
  console.log('');

  if (toUpdate.length > 0) {
    console.log('users to update:');
    for (const { uid, email, update } of toUpdate) {
      const parts = [];
      if (update.mfaFactors) {
        parts.push(
          `mfaFactors={totp:${update.mfaFactors.totp},passkeys:${update.mfaFactors.passkeys}}`
        );
      }
      if (update.mfaEnrolled !== undefined) {
        parts.push(`mfaEnrolled=${update.mfaEnrolled}`, 'requiresMfaSetup=false');
      }
      console.log(`  users/${uid}  ${parts.join(' ')}   ${email ?? 'unknown'}`);
    }
    console.log('');
  }

  if (skipped.length > 0) {
    console.log('⚠️  skipped:');
    for (const { uid, reason, detail } of skipped) {
      console.log(`  users/${uid}  [${reason}]${detail ? ` ${detail}` : ''}`);
    }
    console.log('');
  }

  if (errored.length > 0) {
    console.log('❌ errored:');
    for (const { uid, stage, error } of errored) {
      console.log(`  users/${uid}  [${stage}] ${error}`);
    }
    console.log('');
  }

  console.log(`firestore rules review: ${rulesReview.ruleChangeRequired ? 'CHANGE REQUIRED' : 'no rule change required'} (details in the log)\n`);

  const logPath =
    logFileArg || join(ROOT, 'scripts', `backfill-mfa-factors.${projectId}.log.json`);
  const logDoc = {
    script: 'backfill-mfa-factors',
    projectId,
    env,
    mode,
    dryRun,
    startedAt: new Date().toISOString(),
    completedAt: null,
    counts: {
      scanned: users.length,
      toUpdate: toUpdate.length,
      updated: 0,
      alreadyCorrect: alreadyCorrect.length,
      skipped: skipped.length,
      errored: errored.length,
      promotions: promotionPreview.length,
    },
    planned: toUpdate.map(forLog),
    applied: [],
    skipped,
    errored,
    promotionPreview,
    rulesReview,
  };

  /**
   * Never silently clobber the record of a live run. These are scalar
   * overwrites, so a committed log holds the only pre-image of what the
   * fields used to be; a later dry run landing on the same canonical path
   * would otherwise destroy it.
   */
  function writeLog() {
    if (existsSync(logPath)) {
      try {
        const existing = JSON.parse(readFileSync(logPath, 'utf8'));
        if (existing?.dryRun === false && Array.isArray(existing.applied) && existing.applied.length > 0) {
          // A custom --log-file need not end in `.log.json`, in which case the
          // substitution is a no-op and the rename would silently self-cancel.
          const substituted = logPath.replace(/\.log\.json$/, '.prev.log.json');
          const backup = substituted === logPath ? `${logPath}.prev` : substituted;
          renameSync(logPath, backup);
          console.log(`preserved previous committed log as ${backup}`);
        }
      } catch {
        // An unparseable log is not a reason to abort the run; the fresh log
        // is about to replace it either way.
      }
    }
    writeFileSync(logPath, JSON.stringify(logDoc, null, 2));
  }

  if (dryRun) {
    logDoc.completedAt = new Date().toISOString();
    writeLog();
    console.log(`log: ${logPath}`);
    console.log('[DRY RUN] no writes performed. re-run with --commit to apply.\n');
    return;
  }

  if (toUpdate.length === 0) {
    logDoc.completedAt = new Date().toISOString();
    writeLog();
    console.log(`log: ${logPath}`);
    console.log('✅ nothing to update.\n');
    return;
  }

  // Gate on the project we actually resolved, not on the flag.
  if (PROTECTED_PROJECT_IDS.has(projectId)) {
    const confirmed = await promptYesNo(
      `Write ${toUpdate.length} user document(s) in PRODUCTION (${projectId}), mode=${mode}` +
        `${mode === 'full' ? `, promoting ${promotionPreview.length} to mfaEnrolled: true` : ''}? [y/N] `
    );
    if (!confirmed) {
      console.log('aborted — no writes performed.\n');
      process.exit(3);
    }
  }

  // Write the log BEFORE committing: if the process dies mid-run, this file
  // is the only record of what was intended and of the pre-images. Entries
  // move into `applied` as batches land.
  writeLog();
  console.log(`log: ${logPath}\n`);

  let written = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH_LIMIT) {
    const chunk = toUpdate.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const { uid, update } of chunk) {
      // set-merge, matching how mfaFactors.server.ts writes the same fields.
      batch.set(db.collection('users').doc(uid), update, { merge: true });
    }
    await batch.commit();
    logDoc.applied.push(...chunk.map(forLog));
    logDoc.counts.updated = logDoc.applied.length;
    writeFileSync(logPath, JSON.stringify(logDoc, null, 2));
    written += chunk.length;
    console.log(`  committed ${written}/${toUpdate.length}`);
  }

  logDoc.completedAt = new Date().toISOString();
  writeFileSync(logPath, JSON.stringify(logDoc, null, 2));

  console.log(`\n✅ updated ${written} user document(s) in mode=${mode}.`);
  if (mode === 'inventory-only' && promotionPreview.length > 0) {
    console.log(
      `   ${promotionPreview.length} user(s) would gain mfaEnrolled under --mode=full — ` +
        'do not run it until the passkey challenge is live here.'
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error('\n❌ backfill failed:', err);
  process.exit(1);
});
