/**
 * Cloudflare Turnstile server-side verification.
 *
 * Browser -> our API -> siteverify. Never called from the client: the secret
 * would leak and the verdict would be attacker-controlled.
 *
 * Deliberate scope: guards `/api/users/bootstrap` and
 * `/api/auth/forgot-password` only. Login is NOT covered and register only
 * partly, because `signInWithEmailAndPassword` /
 * `createUserWithEmailAndPassword` hit Firebase identitytoolkit straight from
 * the browser — our server is not in that path. App Check is the right
 * instrument there. Do NOT add a widget to the login page: it would look like
 * protection without being any.
 */

import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/rateLimit';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 10_000;
/** Cloudflare documents tokens as <=2048 chars; longer input is never valid. */
const MAX_TOKEN_LENGTH = 2048;

/** Stable per-surface action, asserted against the siteverify response. */
export type TurnstileAction = 'register' | 'forgot-password';

/** The wire field name Cloudflare's widget uses. Kept verbatim. */
export const TURNSTILE_TOKEN_FIELD = 'cf-turnstile-response';

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: string };

export function isTurnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET);
}

function expectedHostnames(): Set<string> {
  return new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map(hostname => hostname.trim())
      .filter(Boolean)
  );
}

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
  metadata?: { result_with_testing_key?: boolean };
}

/**
 * Verify a Turnstile token for a surface. Fails closed on every uncertain path
 * (network error, non-2xx, unparseable body, missing prod config). The one
 * permissive branch is non-production with no secret, so local `next dev` works.
 */
export async function verifyTurnstileToken(
  request: NextRequest,
  token: unknown,
  action: TurnstileAction
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET;

  if (!secret) {
    // Production with no secret is a misconfiguration, not a reason to let
    // unverified traffic through. `instrumentation.ts` raises this at boot too.
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'not_configured' };
    }
    return { ok: true };
  }

  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'missing_token' };
  }

  const hostnames = expectedHostnames();
  if (hostnames.size === 0) {
    return { ok: false, reason: 'no_expected_hostnames' };
  }

  let result: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: getClientIp(request),
      }),
    });
    if (!response.ok) throw new Error(`siteverify ${response.status}`);
    result = (await response.json()) as SiteverifyResponse;
  } catch {
    // Network failure, non-2xx, or non-JSON body. Fail closed.
    return { ok: false, reason: 'siteverify_unreachable' };
  }

  if (!result.success) {
    return { ok: false, reason: (result['error-codes'] ?? []).join(',') || 'rejected' };
  }

  // Cloudflare's testing keys return no `action` and a fake `hostname`, marked
  // by `metadata.result_with_testing_key`. Safe to trust: only OUR secret can
  // produce that marker. Keeps E2E on this code path instead of a bypass.
  const usingTestingKey = result.metadata?.result_with_testing_key === true;

  if (!usingTestingKey && result.action !== action) {
    return { ok: false, reason: 'action_mismatch' };
  }

  if (!result.hostname || !hostnames.has(result.hostname)) {
    return { ok: false, reason: 'hostname_mismatch' };
  }

  return { ok: true };
}
