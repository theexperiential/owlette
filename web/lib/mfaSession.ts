/**
 * MFA Session Management
 * Handles verification status and device trust for two-factor authentication
 */

const MFA_VERIFIED_KEY = 'mfa_verified_session';
const MFA_TRUSTED_DEVICE_KEY = 'mfa_trusted_device';
const TRUST_DURATION_DAYS = 30;

interface TrustedDeviceData {
  userId: string;
  expiresAt: number;
}

/**
 * Mark MFA as verified for the current session
 */
export function setMfaVerifiedForSession(userId: string): void {
  if (typeof window !== 'undefined') {
    sessionStorage.setItem(MFA_VERIFIED_KEY, userId);
  }
}

/**
 * Check if MFA is verified for the current session
 */
export function isMfaVerifiedInSession(userId: string): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(MFA_VERIFIED_KEY) === userId;
}

/**
 * Clear MFA verification status (on sign out)
 */
export function clearMfaSession(): void {
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(MFA_VERIFIED_KEY);
  }
}

/**
 * Trust this device for 30 days
 */
export function trustDevice(userId: string): void {
  if (typeof window === 'undefined') return;

  const expiresAt = Date.now() + (TRUST_DURATION_DAYS * 24 * 60 * 60 * 1000);
  const data: TrustedDeviceData = { userId, expiresAt };

  localStorage.setItem(MFA_TRUSTED_DEVICE_KEY, JSON.stringify(data));
}

/**
 * Check if this device is trusted for the given user
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
 * Remove device trust (user can manually revoke)
 */
export function untrustDevice(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(MFA_TRUSTED_DEVICE_KEY);
  }
}
