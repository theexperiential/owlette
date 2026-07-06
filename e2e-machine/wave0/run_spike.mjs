/**
 * Wave 0 spike — prove headless agent pairing against LIVE dev, end to end,
 * with zero human and zero browser. This is the make-or-break assumption the
 * whole full-machine e2e gate rests on (dev/active/full-machine-e2e/plan.md).
 *
 * Flow: seed a least-privilege site-owner + e2e site in dev  ->  mint a
 * __session cookie via Identity Toolkit + /api/auth/session  ->  generate a
 * pairing phrase (preauthorizedIntent)  ->  authorize it (deferTokenMint)  ->
 * hand the phrase to the agent's real Python+requests poller with a SYNTHETIC
 * machineId  ->  assert real tokens come back and an agent_refresh_tokens doc
 * lands in dev Firestore  ->  tear everything down.
 *
 * Safety: hard-pins the dev project (aborts on any other), never runs
 * configure_site.py (so this box's live .tokens.enc is untouched), and tears
 * down user + site + token docs in a finally block.
 *
 * Run:  node e2e-machine/wave0/run_spike.mjs
 * Never commit real credentials — the generated password stays in memory only.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Derive the repo root from this script's own location so the spike runs
// unchanged on any machine that clones the repo.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'web', 'package.json'));
const admin = require('firebase-admin');

// ---- hard safety pins ----------------------------------------------------
const EXPECTED_PROJECT = 'owlette-dev-3838a';
const API_BASE = 'https://dev.owlette.app';
const SA_PATH = path.join(REPO, 'agent', 'config', 'firebase-creds-dev.json');
const POLL_SCRIPT = path.join(HERE, 'poll_agent.py');

// Prefer the agent's bundled Python (most faithful Cloudflare/UA test); fall
// back to an explicit override or the capture-native venv on a machine without
// the agent installed. Whatever runs must have `requests`.
const PY_CANDIDATES = [
  process.env.OWLETTE_AGENT_PY,
  'C:/ProgramData/Owlette/python/python.exe',
  path.join(REPO, 'dev', 'video-tutorials', 'capture-native', '.venv', 'Scripts', 'python.exe'),
].filter(Boolean);
const AGENT_PY = PY_CANDIDATES.find((p) => existsSync(p)) || 'python';
// Controller calls are allowed to look like curl (the plan permits curl for
// setup calls); only the Python poller must use the agent's default UA.
const CURL_UA = 'curl/8.4.0';

if (!API_BASE.startsWith('https://dev.')) {
  console.error('ABORT: API_BASE is not the dev host');
  process.exit(2);
}

// Read the SA only to guard the project id — never logged, never committed.
const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
if (sa.project_id !== EXPECTED_PROJECT) {
  console.error(`ABORT: service account project '${sa.project_id}' != '${EXPECTED_PROJECT}'`);
  process.exit(2);
}

// Dev web API key (NEXT_PUBLIC — already in the client bundle) from env.local.
const envLocal = readFileSync(path.join(REPO, 'web', '.env.local'), 'utf8');
const apiKey = (envLocal.match(/NEXT_PUBLIC_FIREBASE_API_KEY\s*=\s*"?([^"\r\n]+)"?/) || [])[1];
if (!apiKey) {
  console.error('ABORT: could not read NEXT_PUBLIC_FIREBASE_API_KEY from web/.env.local');
  process.exit(2);
}

admin.initializeApp({ credential: admin.credential.cert(sa), projectId: EXPECTED_PROJECT });
const db = admin.firestore();
const auth = admin.auth();

// ---- e2e identities (obvious, easy to sweep) -----------------------------
const SITE_ID = 'e2e-wave0-site';
const USER_UID = 'e2e-wave0-user';
const USER_EMAIL = 'e2e-wave0@owlette.test';
const MACHINE_ID = 'e2e-wave0-vm';
const PASSWORD = `Wv0-${randomBytes(15).toString('base64url')}!aA9`;

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${stage}${detail ? ' | ' + detail : ''}`);
}

function apiHeaders(cookie) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': CURL_UA, Accept: 'application/json' };
  if (cookie) h.cookie = cookie;
  return h;
}

let phrase = null;

try {
  // ---- 0.1 seed least-privilege site-owner + e2e site --------------------
  try {
    await auth.getUser(USER_UID);
    await auth.updateUser(USER_UID, { email: USER_EMAIL, password: PASSWORD, emailVerified: true });
  } catch {
    await auth.createUser({ uid: USER_UID, email: USER_EMAIL, password: PASSWORD, emailVerified: true });
  }
  await db.collection('users').doc(USER_UID).set({
    email: USER_EMAIL, role: 'member', sites: [SITE_ID], displayName: 'E2E Wave0',
    mfaEnrolled: false, requiresMfaSetup: false, createdAt: new Date(),
  });
  await db.collection('sites').doc(SITE_ID).set({
    name: 'E2E Wave0 Spike', owner: USER_UID, timezone: 'UTC', createdAt: new Date(),
  });
  record('0.1 seed site-owner + e2e site', true, `${USER_EMAIL} owns ${SITE_ID} (role=member, not superadmin)`);

  // ---- 0.2a email+password -> Firebase ID token --------------------------
  const signInRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: PASSWORD, returnSecureToken: true }) },
  );
  const signInJson = await signInRes.json();
  const mfaBlocked = Boolean(signInJson.mfaPendingCredential);
  if (!signInJson.idToken) throw new Error('signInWithPassword: ' + JSON.stringify(signInJson));
  record('0.2a Firebase ID token (signInWithPassword)', true, mfaBlocked ? 'MFA challenge (unexpected!)' : 'no MFA challenge');

  // ---- 0.2b exchange ID token -> __session cookie ------------------------
  const sessRes = await fetch(`${API_BASE}/api/auth/session`, {
    method: 'POST', headers: apiHeaders(), body: JSON.stringify({ idToken: signInJson.idToken }),
  });
  const setCookie = sessRes.headers.get('set-cookie');
  if (!sessRes.ok || !setCookie) throw new Error(`session mint ${sessRes.status}: ${await sessRes.text()}`);
  const cookie = setCookie.split(';')[0];
  record('0.2b __session cookie minted', cookie.startsWith('__session='), `status ${sessRes.status}`);

  // ---- 0.2c confirm the session (MFA gate check) -------------------------
  const confRes = await fetch(`${API_BASE}/api/auth/session`, { headers: apiHeaders(cookie) });
  const conf = await confRes.json();
  const sessionUsable = conf.authenticated === true && conf.mfaVerified !== false;
  record('0.2c session usable (MFA not blocking)', sessionUsable, `authenticated=${conf.authenticated} mfaVerified=${conf.mfaVerified}`);

  // ---- 0.3a generate pairing phrase (preauthorizedIntent) ----------------
  const genRes = await fetch(`${API_BASE}/api/agent/auth/device-code`, {
    method: 'POST', headers: apiHeaders(cookie), body: '{}',
  });
  const genJson = await genRes.json();
  phrase = genJson.pairPhrase;
  if (!phrase) throw new Error(`generate ${genRes.status}: ${JSON.stringify(genJson)}`);
  record('0.3a phrase generated', true, `"${phrase}" expiresIn=${genJson.expiresIn}s`);

  // ---- 0.3b authorize (deferTokenMint) -----------------------------------
  const authzRes = await fetch(`${API_BASE}/api/agent/auth/device-code/authorize`, {
    method: 'POST', headers: apiHeaders(cookie), body: JSON.stringify({ pairPhrase: phrase, siteId: SITE_ID }),
  });
  const authz = await authzRes.json();
  if (!authzRes.ok || authz.success !== true) throw new Error(`authorize ${authzRes.status}: ${JSON.stringify(authz)}`);
  record('0.3b authorized (deferTokenMint)', true, `siteId=${SITE_ID}`);

  // ---- 0.5 + 0.4 agent-faithful poll (Python requests, default UA) -------
  const poll = spawnSync(AGENT_PY, [POLL_SCRIPT, API_BASE, phrase, MACHINE_ID, 'e2e-wave0/3.0.0'],
    { encoding: 'utf8', timeout: 90000 });
  const pollOut = (poll.stdout || '').trim();
  if (poll.stderr && poll.stderr.trim()) console.log('[python stderr] ' + poll.stderr.trim());
  let pollJson;
  try { pollJson = JSON.parse(pollOut.split('\n').filter(Boolean).pop()); }
  catch { pollJson = { reached: false, error: 'unparseable python output: ' + pollOut }; }

  record('0.5 Cloudflare/UA: python-requests reached dev poll', pollJson.reached === true && !pollJson.cloudflare_blocked,
    `http=${pollJson.status} polls=${pollJson.polls} cloudflare_blocked=${pollJson.cloudflare_blocked}`);
  const gotTokens = Boolean(pollJson.accessToken && pollJson.refreshToken);
  record('0.4 headless mint returned real tokens', gotTokens,
    gotTokens ? `access=${pollJson.accessToken.length}b refresh=${pollJson.refreshToken.length}b site=${pollJson.siteId}`
      : `no tokens: ${pollJson.error || 'unknown'}`);

  // ---- 0.4b assert the refresh-token doc landed in dev Firestore ---------
  const rtSnap = await db.collection('agent_refresh_tokens').where('siteId', '==', SITE_ID).get();
  const rt = rtSnap.docs[0]?.data();
  record('0.4b agent_refresh_tokens doc created', rtSnap.size >= 1,
    rt ? `${rtSnap.size} doc(s), machineId=${rt.machineId}, agentUid=${rt.agentUid ? 'set' : 'unset'}` : 'none found');
} catch (err) {
  record('SPIKE ERROR', false, err.message);
} finally {
  // ---- 0.6 teardown (always) --------------------------------------------
  let removed = 0;
  try {
    if (phrase) await db.collection('device_codes').doc(phrase).delete().catch(() => {});
    const rts = await db.collection('agent_refresh_tokens').where('siteId', '==', SITE_ID).get();
    for (const d of rts.docs) { await d.ref.delete(); removed++; }
    const machines = await db.collection('sites').doc(SITE_ID).collection('machines').get();
    for (const d of machines.docs) await d.ref.delete();
    await db.collection('sites').doc(SITE_ID).delete();
    await db.collection('users').doc(USER_UID).delete();
    await auth.deleteUser(USER_UID).catch(() => {});
    record('0.6 teardown complete', true, `removed user + site + ${removed} token doc(s)`);
  } catch (err) {
    record('0.6 teardown', false, err.message + ` (manual cleanup: site=${SITE_ID} user=${USER_UID})`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nWAVE 0 RESULT: ${results.length - failed.length}/${results.length} stages passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
