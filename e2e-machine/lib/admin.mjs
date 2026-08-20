/**
 * Shared cloud-side helpers for the full-machine e2e harness.
 *
 * All Firestore/Auth admin work and the __session cookie mint live here (Node, reusing
 * web/node_modules/firebase-admin) so the Python controller never touches firebase-admin,
 * which the agent is forbidden to import. Thin CLIs (preauthorize/probe/teardown) wrap
 * these and exchange JSON on stdout.
 *
 * Dev-pinned: aborts unless the service account resolves to owlette-dev-3838a.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'web', 'package.json'));
const admin = require('firebase-admin');

export const EXPECTED_PROJECT = 'owlette-dev-3838a';
export const API_BASE = 'https://dev.owlette.app';
const CURL_UA = 'curl/8.4.0'; // controller calls may look like curl; the agent poll must not

// Dedicated e2e identities. The site + owner persist across runs (idempotent
// seed); per-run machine + token docs are torn down each run.
export const SITE_ID = 'e2e-fullmachine';
export const OWNER_UID = 'e2e-fullmachine-owner';
export const OWNER_EMAIL = 'e2e-fullmachine@owlette.test';

const SA_PATH = path.join(REPO, 'agent', 'config', 'firebase-creds-dev.json');

let _state = null;
export function init() {
  if (_state) return _state;
  if (!existsSync(SA_PATH)) {
    throw new Error(`missing dev service account at ${SA_PATH} (gitignored — obtain it out-of-band)`);
  }
  const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
  if (sa.project_id !== EXPECTED_PROJECT) {
    throw new Error(`ABORT: service account project '${sa.project_id}' != '${EXPECTED_PROJECT}'`);
  }
  if (!API_BASE.startsWith('https://dev.')) throw new Error('ABORT: API_BASE is not a dev host');

  const envLocalPath = path.join(REPO, 'web', '.env.local');
  if (!existsSync(envLocalPath)) throw new Error(`missing ${envLocalPath} (gitignored — obtain it out-of-band)`);
  const apiKey = (readFileSync(envLocalPath, 'utf8').match(/NEXT_PUBLIC_FIREBASE_API_KEY\s*=\s*"?([^"\r\n]+)"?/) || [])[1];
  if (!apiKey) throw new Error('NEXT_PUBLIC_FIREBASE_API_KEY not found in web/.env.local');

  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: EXPECTED_PROJECT });
  _state = { db: admin.firestore(), auth: admin.auth(), apiKey };
  return _state;
}

function headers(cookie) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': CURL_UA, Accept: 'application/json' };
  if (cookie) h.cookie = cookie;
  return h;
}

/** Seed the e2e site + least-privilege owner (idempotent). Alerts OFF so the
 *  machine's appear/vanish cycle can never fire offline emails. Returns the
 *  freshly-set password (in memory only — never persisted). */
export async function seedSiteAndOwner() {
  const { auth, db } = init();
  const password = `Fm-${randomBytes(15).toString('base64url')}!aA9`;
  try {
    await auth.getUser(OWNER_UID);
    await auth.updateUser(OWNER_UID, { email: OWNER_EMAIL, password, emailVerified: true });
  } catch {
    await auth.createUser({ uid: OWNER_UID, email: OWNER_EMAIL, password, emailVerified: true });
  }
  await db.collection('users').doc(OWNER_UID).set({
    email: OWNER_EMAIL, role: 'member', sites: [SITE_ID], displayName: 'E2E Full-Machine',
    mfaEnrolled: false, requiresMfaSetup: false, createdAt: new Date(),
    preferences: {
      healthAlerts: false, processAlerts: false, thresholdAlerts: false, cortexAlerts: false,
      mutedMachines: [], alertCcEmails: [],
    },
  }, { merge: true });
  await db.collection('sites').doc(SITE_ID).set({
    name: 'E2E Full-Machine Gate', owner: OWNER_UID, timezone: 'UTC', createdAt: new Date(),
  }, { merge: true });
  return password;
}

/** email+password -> Firebase ID token -> __session cookie string. */
export async function mintSessionCookie(password) {
  const { apiKey } = init();
  const signIn = await (await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, password, returnSecureToken: true }) },
  )).json();
  if (!signIn.idToken) throw new Error('signInWithPassword: ' + JSON.stringify(signIn));
  const res = await fetch(`${API_BASE}/api/auth/session`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ idToken: signIn.idToken }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (!res.ok || !setCookie) throw new Error(`session mint ${res.status}: ${await res.text()}`);
  return setCookie.split(';')[0];
}

/** Generate a pairing phrase (preauthorizedIntent) and authorize it for the
 *  e2e site (deferTokenMint). Returns { phrase, expiresInSec }. The real agent
 *  installer redeems it via /ADD=<phrase>. */
export async function generateAndAuthorizePhrase(cookie) {
  const gen = await (await fetch(`${API_BASE}/api/agent/auth/device-code`, {
    method: 'POST', headers: headers(cookie), body: '{}',
  })).json();
  if (!gen.pairPhrase) throw new Error('generate: ' + JSON.stringify(gen));
  const authz = await (await fetch(`${API_BASE}/api/agent/auth/device-code/authorize`, {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ pairPhrase: gen.pairPhrase, siteId: SITE_ID }),
  })).json();
  if (authz.success !== true) throw new Error('authorize: ' + JSON.stringify(authz));
  return { phrase: gen.pairPhrase, expiresInSec: gen.expiresIn };
}

/** Coerce a Firestore Timestamp | number(seconds) | null into epoch seconds. */
function toEpochSeconds(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return Math.floor(v.toMillis() / 1000);
  if (typeof v._seconds === 'number') return v._seconds; // plain-object Timestamp
  if (typeof v.seconds === 'number') return v.seconds;
  return null;
}

/** Read the machine heartbeat doc + refresh-token count for the e2e site. */
export async function probe(machineId) {
  const { db } = init();
  const m = await db.collection('sites').doc(SITE_ID).collection('machines').doc(machineId).get();
  const rt = await db.collection('agent_refresh_tokens').where('siteId', '==', SITE_ID).get();
  const md = m.exists ? m.data() : null;
  // lastHeartbeat is written as a SERVER_TIMESTAMP, so it reads back as a Timestamp.
  // Normalize to epoch seconds, tolerating a raw number if a write path ever changes.
  const hbSec = toEpochSeconds(md?.lastHeartbeat);
  return {
    siteId: SITE_ID,
    machineId,
    machineExists: m.exists,
    online: md?.online ?? null,
    lastHeartbeat: hbSec,
    lastHeartbeatAgeSec: hbSec !== null ? Math.floor(Date.now() / 1000) - hbSec : null,
    agentVersion: md?.agent_version ?? null,
    refreshTokenCount: rt.size,
    refreshTokenMachineIds: rt.docs.map((d) => d.data().machineId),
  };
}

/** Read the machine's synced config doc — the round-trip target for the GUI
 *  add-process flow. The agent uploads config (minus the firebase section) to
 *  config/{siteId}/machines/{machineId}; a driven "add process" lands here. */
export async function probeConfig(machineId) {
  const { db } = init();
  const c = await db.collection('config').doc(SITE_ID).collection('machines').doc(machineId).get();
  const cd = c.exists ? c.data() : null;
  const procs = Array.isArray(cd?.processes) ? cd.processes : [];
  return {
    siteId: SITE_ID,
    machineId,
    configExists: c.exists,
    processCount: procs.length,
    processNames: procs.map((p) => p?.name).filter((n) => typeof n === 'string'),
  };
}

/** Remove all per-run e2e cloud state for the site. Safe to call repeatedly.
 *  fullReset also deletes the persistent site + owner. */
export async function teardown({ fullReset = false } = {}) {
  const { db, auth } = init();
  const removed = { machines: 0, hardware: 0, configDocs: 0, tokens: 0, deviceCodes: 0, site: false, owner: false };

  const machines = await db.collection('sites').doc(SITE_ID).collection('machines').get();
  for (const d of machines.docs) {
    const hw = await d.ref.collection('hardware').get();
    for (const h of hw.docs) { await h.ref.delete(); removed.hardware++; }
    await d.ref.delete(); removed.machines++;
  }
  // The synced config lives in config/{siteId}/machines/*, not under sites/ — the Wave 2
  // add-process flow writes here, so sweep it too or driven processes leak across runs.
  const cfgMachines = await db.collection('config').doc(SITE_ID).collection('machines').get();
  for (const d of cfgMachines.docs) { await d.ref.delete(); removed.configDocs++; }
  const rts = await db.collection('agent_refresh_tokens').where('siteId', '==', SITE_ID).get();
  for (const d of rts.docs) { await d.ref.delete(); removed.tokens++; }
  const dcs = await db.collection('device_codes').where('siteId', '==', SITE_ID).get();
  for (const d of dcs.docs) { await d.ref.delete(); removed.deviceCodes++; }

  if (fullReset) {
    await db.collection('sites').doc(SITE_ID).delete().catch(() => {});
    await db.collection('config').doc(SITE_ID).delete().catch(() => {});
    removed.site = true;
    await db.collection('users').doc(OWNER_UID).delete().catch(() => {});
    await auth.deleteUser(OWNER_UID).catch(() => {});
    removed.owner = true;
  }
  return removed;
}
