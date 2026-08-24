/**
 * Give the sandboxed agent a credential it can use without any network.
 *
 * The real pairing flow (device code → `/api/agent/auth/device-code/poll` →
 * tokens) needs a human at a browser, so this suite short-circuits it: mint an
 * Auth-emulator ID token carrying the claims `firestore.rules` checks for an
 * agent, and drop it into the sandbox's `.tokens.enc` as a pre-cached access
 * token. `AuthManager.get_valid_token()` serves a cached token straight from
 * storage while `token_expiry > now + 300s` (agent/src/auth_manager.py:512), so
 * nothing calls the refresh endpoint for the life of a run.
 *
 * The claims are the contract, and they are snake_case on purpose —
 * `firestore.rules:62` (`isAgent`) and `:103` (`agentCanAccessMachine`) read
 * `role`, `site_id` and `machine_id` off the token verbatim. Getting these wrong
 * surfaces as a 403 on every write, not as an auth error.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID, getAdminAuth } from '../helpers/emulator'
import { AGENT_SRC, PYTHON, agentEnv, assertSandboxSafe } from './sandbox'

/** Anything non-empty works against the Auth emulator; matches the suite's web env. */
const EMULATOR_API_KEY = 'demo-api-key'

const AGENT_PASSWORD = 'e2e-agent-password'

export interface AgentCredential {
  uid: string
  idToken: string
  /** Unix seconds. */
  expiry: number
}

/**
 * Create (or reuse) the agent's Auth account, stamp the agent claims on it, and
 * exchange them for an ID token.
 *
 * Password sign-in rather than `createCustomToken` deliberately: custom-token
 * minting wants a signing credential, and the emulator's unsigned-token
 * behaviour is an implementation detail to lean on. Password sign-in is a
 * documented emulator endpoint, and custom claims set beforehand are baked into
 * the ID token it returns — which is all the rules evaluate.
 *
 * Note there is no `users/{uid}` document, and there must not be: an agent is
 * not a dashboard user, and `isAgent()` reads claims only.
 */
export async function mintAgentToken(
  siteId: string,
  machineId: string,
): Promise<AgentCredential> {
  const auth = getAdminAuth()
  const uid = `agent-${machineId}`
  const email = `${uid.toLowerCase()}@e2e.agent`

  try {
    await auth.createUser({ uid, email, password: AGENT_PASSWORD, emailVerified: true })
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(uid, { email, password: AGENT_PASSWORD, emailVerified: true })
    } else {
      throw err
    }
  }

  await auth.setCustomUserClaims(uid, {
    role: 'agent',
    site_id: siteId,
    machine_id: machineId,
  })

  const res = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${EMULATOR_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: AGENT_PASSWORD, returnSecureToken: true }),
    },
  )
  if (!res.ok) {
    throw new Error(
      `Auth emulator refused the agent sign-in (${res.status}): ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { idToken?: string; expiresIn?: string }
  if (!body.idToken) {
    throw new Error('Auth emulator returned no idToken for the agent account')
  }

  assertAgentClaims(body.idToken, siteId, machineId)

  const expiresIn = Number(body.expiresIn ?? 3600)
  return { uid, idToken: body.idToken, expiry: Math.floor(Date.now() / 1000) + expiresIn }
}

/**
 * Fail here, not 30 seconds later on a wall of 403s.
 *
 * Decodes the payload without verifying — the emulator's signature is not the
 * thing under test, the claim NAMES are. A camelCase slip (`siteId`) reads as a
 * perfectly valid token that every rule rejects.
 */
function assertAgentClaims(idToken: string, siteId: string, machineId: string): void {
  const segment = idToken.split('.')[1]
  if (!segment) throw new Error('agent ID token is not a JWT')
  const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >

  const expected: Record<string, string> = {
    role: 'agent',
    site_id: siteId,
    machine_id: machineId,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (claims[key] !== value) {
      throw new Error(
        `agent ID token claim ${key}=${JSON.stringify(claims[key])}, expected ${JSON.stringify(value)}. ` +
          'firestore.rules reads these verbatim and snake_case is required.',
      )
    }
  }
  if (claims.aud !== EMULATOR_PROJECT_ID) {
    throw new Error(
      `agent ID token aud=${String(claims.aud)}, expected ${EMULATOR_PROJECT_ID}`,
    )
  }
}

/**
 * Encrypt the credential into `<sandbox>/Owlette/.tokens.enc` using the agent's
 * own SecureStorage, via a python child that sees the sandbox as its PROGRAMDATA.
 * Returns the path it wrote.
 */
export function writeTokenStore(
  programData: string,
  siteId: string,
  credential: AgentCredential,
): string {
  assertSandboxSafe(programData)

  const payload = JSON.stringify({
    access_token: credential.idToken,
    expiry: credential.expiry,
    site_id: siteId,
    // Never used in a run this short, but `is_authenticated()` gates the whole
    // connect path on a refresh token existing (firebase_client._do_connect).
    refresh_token: 'e2e-desktop-sync-refresh-token-unused',
  })

  const out = execFileSync(
    PYTHON,
    [path.join(__dirname, 'seed_tokens.py')],
    { cwd: AGENT_SRC, env: agentEnv(programData), input: payload, encoding: 'utf8', windowsHide: true },
  )

  const { tokenFile } = JSON.parse(out.trim().split(/\r?\n/).pop() as string) as {
    tokenFile: string
  }
  return tokenFile
}
