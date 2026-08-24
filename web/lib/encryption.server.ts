/**
 * AES-256-GCM authenticated encryption, keyed by scrypt over MFA_ENCRYPTION_KEY.
 * Server-only — never import from a client component.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/** scrypt-derive a 256-bit key from MFA_ENCRYPTION_KEY and a per-value salt. */
function getEncryptionKey(salt: Buffer): Buffer {
  const secret = process.env.MFA_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error('MFA_ENCRYPTION_KEY environment variable is not set');
  }

  return scryptSync(secret, salt, KEY_LENGTH);
}

/** @returns `salt:iv:authTag:ciphertext`, each part base64. */
export function encrypt(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = getEncryptionKey(salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

/** @throws on a wrong key or tampered data — GCM auth failure. */
export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format');
  }

  const [saltB64, ivB64, authTagB64, ciphertext] = parts;

  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const key = getEncryptionKey(salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/** Whether MFA_ENCRYPTION_KEY is set. */
export function isEncryptionConfigured(): boolean {
  return !!process.env.MFA_ENCRYPTION_KEY;
}
