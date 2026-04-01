import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';

// Configure TOTP settings
authenticator.options = {
  step: 30, // Time step in seconds (standard is 30)
  window: 1, // Allow 1 time step before and after (prevents timing issues)
};

/**
 * Generate a new TOTP secret for a user
 */
export function generateTOTPSecret(): string {
  return authenticator.generateSecret();
}

/**
 * Generate a QR code data URL for TOTP setup
 * @param email User's email address
 * @param secret TOTP secret
 * @returns Data URL for QR code image
 */
export async function generateQRCode(email: string, secret: string): Promise<string> {
  const appName = 'Owlette';
  const otpauth = authenticator.keyuri(email, appName, secret);

  try {
    const qrCodeDataURL = await QRCode.toDataURL(otpauth);
    return qrCodeDataURL;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw new Error('Failed to generate QR code');
  }
}

/**
 * Verify a TOTP token against a secret
 * @param token 6-digit TOTP code from user
 * @param secret User's TOTP secret
 * @returns true if valid, false otherwise
 */
export function verifyTOTP(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch (error) {
    console.error('Error verifying TOTP:', error);
    return false;
  }
}

/**
 * Generate backup codes for account recovery
 * @param count Number of backup codes to generate (default: 10)
 * @returns Array of backup codes
 */
export function generateBackupCodes(count: number = 10): string[] {
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    // Generate 8-character alphanumeric code
    const code = crypto
      .randomBytes(4)
      .toString('hex')
      .toUpperCase();
    codes.push(code);
  }

  return codes;
}

/**
 * Hash a backup code for secure storage
 * @param code Plain text backup code
 * @returns Hashed backup code
 */
export function hashBackupCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');
}

/**
 * Verify a backup code against stored hash
 * @param code Plain text backup code from user
 * @param hash Stored hash to compare against
 * @returns true if valid, false otherwise
 */
export function verifyBackupCode(code: string, hash: string): boolean {
  const codeHash = hashBackupCode(code);
  return codeHash === hash;
}

/**
 * Encrypt TOTP secret for storage using AES-256-GCM
 * @param secret TOTP secret to encrypt
 * @param userKey User-specific encryption key (e.g., derived from UID)
 * @returns Encrypted secret in format: salt:iv:authTag:ciphertext (base64)
 */
export function encryptSecret(secret: string, userKey: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(userKey, salt, 32);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(secret, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

/**
 * Decrypt TOTP secret from storage (AES-256-GCM)
 * @param encryptedSecret Encrypted TOTP secret in format: salt:iv:authTag:ciphertext
 * @param userKey User-specific encryption key
 * @returns Decrypted secret
 */
export function decryptSecret(encryptedSecret: string, userKey: string): string {
  try {
    // Guard against legacy AES-CBC hex format (pre-GCM migration)
    if (!encryptedSecret.includes(':')) {
      throw new Error('Legacy TOTP secret format — user must re-enroll MFA');
    }

    const parts = encryptedSecret.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted data format');
    }

    const [saltB64, ivB64, authTagB64, ciphertext] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const key = crypto.scryptSync(userKey, salt, 32);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Error decrypting secret:', error);
    throw new Error('Failed to decrypt TOTP secret');
  }
}
