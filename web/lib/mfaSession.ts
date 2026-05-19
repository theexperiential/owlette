/**
 * MFA Session Management — CLIENT-SIDE STUBS (deprecated as of Wave 2).
 *
 * Prior to the server-enforced MFA migration (Wave 2), this module was the
 * source of truth for whether the current session had passed an MFA
 * challenge: sessionStorage held a `mfa_verified_session` key and the
 * dashboard read it to decide whether to render. That was decorative — a
 * user could clear sessionStorage (or simply navigate directly to a
 * protected page) and bypass the check entirely.
 *
 * The proxy + iron-session cookie now hold the authoritative `mfaVerified`
 * flag. `setMfaVerifiedForSession()` is preserved as a NO-OP (with a
 * one-time deprecation warning) so older call sites do not crash; new code
 * must NOT rely on it. The read-side helpers are retained but should be
 * treated as UI hints only — the server-side gate is the trust boundary.
 *
 * Device-trust ("trust this device for 30 days") remains a sessionless
 * client-side affordance. The proxy still gates protected paths on the
 * server-side session, which currently always requires MFA when enrolled,
 * so the checkbox does not yet do what it says. Wave 3 will fold device
 * trust into the session cookie so this behaviour matches the label.
 */

const MFA_VERIFIED_KEY = 'mfa_verified_session';
const MFA_TRUSTED_DEVICE_KEY = 'mfa_trusted_device';
const TRUST_DURATION_DAYS = 30;

interface TrustedDeviceData {
  userId: string;
  expiresAt: number;
}

let deprecationLogged = false;
function logDeprecationOnce(fnName: string): void {
  if (deprecationLogged) return;
  deprecationLogged = true;
  console.warn(
    `[mfaSession] ${fnName} is deprecated. ` +
      'MFA verification is now enforced server-side via the proxy + iron-session ' +
      'cookie. This client-side helper is a no-op and will be removed in a ' +
      'future release.'
  );
}

/**
 * @deprecated Wave 2 moved the MFA verification flag into the server-side
 * iron-session cookie. This call is a no-op kept only for source-level
 * compatibility with older modules that import it.
 */
export function setMfaVerifiedForSession(_userId: string): void {
  logDeprecationOnce('setMfaVerifiedForSession');
  void _userId;
}

/**
 * Legacy read of the sessionStorage flag. New code should not rely on
 * this — call GET /api/auth/session instead and read `mfaVerified`.
 */
export function isMfaVerifiedInSession(userId: string): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(MFA_VERIFIED_KEY) === userId;
}

/**
 * Clear the legacy sessionStorage flag on sign-out. Sign-out also
 * destroys the iron-session cookie via DELETE /api/auth/session, which is
 * the real teardown — this just removes the now-obsolete client flag so
 * a future user on the same device doesn't see it stick around.
 */
export function clearMfaSession(): void {
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(MFA_VERIFIED_KEY);
  }
}

/**
 * Trust this device for 30 days.
 *
 * NOTE: this is currently a client-side hint only. The server-side MFA
 * gate (proxy + iron-session) still challenges on every new session when
 * MFA is enrolled. Wave 3 will integrate trusted-device fingerprints into
 * the session cookie so this checkbox behaves as labelled.
 */
export function trustDevice(userId: string): void {
  if (typeof window === 'undefined') return;

  const expiresAt = Date.now() + (TRUST_DURATION_DAYS * 24 * 60 * 60 * 1000);
  const data: TrustedDeviceData = { userId, expiresAt };

  localStorage.setItem(MFA_TRUSTED_DEVICE_KEY, JSON.stringify(data));
}

/**
 * Check if this device is trusted for the given user. UI hint only;
 * never used as a gate.
 */
export function isDeviceTrusted(userId: string): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const stored = localStorage.getItem(MFA_TRUSTED_DEVICE_KEY);
    if (!stored) return false;

    const data = JSON.parse(stored);

    // Validate parsed data matches expected shape
    if (!data || typeof data.userId !== 'string' || typeof data.expiresAt !== 'number') {
      localStorage.removeItem(MFA_TRUSTED_DEVICE_KEY);
      return false;
    }

    // Check if it's the same user and not expired
    if (data.userId !== userId) return false;
    if (data.expiresAt < Date.now()) {
      // Trust expired, remove it
      localStorage.removeItem(MFA_TRUSTED_DEVICE_KEY);
      return false;
    }

    return true;
  } catch {
    // Corrupted or tampered data — remove it
    localStorage.removeItem(MFA_TRUSTED_DEVICE_KEY);
    return false;
  }
}

/**
 * Remove device trust (user can manually revoke).
 */
export function untrustDevice(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(MFA_TRUSTED_DEVICE_KEY);
  }
}
