/**
 * Server-side encryption utilities for sensitive data
 *
 * Uses AES-256-GCM for authenticated encryption
 * Key is derived from MFA_ENCRYPTION_KEY environment variable
 *
 * IMPORTANT: This file should only be imported in server components/API routes
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Get encryption key from environment variable
 * Uses scrypt to derive a proper key from the secret
 */
function getEncryptionKey(salt: Buffer): Buffer {
  const secret = process.env.MFA_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error('MFA_ENCRYPTION_KEY environment variable is not set');
  }

  // Derive a 256-bit key from the secret using scrypt
  return scryptSync(secret, salt, KEY_LENGTH);
}

/**
 * Encrypt a string value
 *
 * @param plaintext - The string to encrypt
 * @returns Base64-encoded encrypted data (salt:iv:authTag:ciphertext)
 */
export function encrypt(plaintext: string): string {
  // Generate random salt and IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive key from secret and salt
  const key = getEncryptionKey(salt);

  // Create cipher and encrypt
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  // Combine salt, IV, auth tag, and ciphertext
  // Format: salt:iv:authTag:ciphertext (all base64)
  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

/**
 * Decrypt an encrypted string
 *
 * @param encryptedData - Base64-encoded encrypted data from encrypt()
 * @returns The original plaintext string
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decrypt(encryptedData: string): string {
  // Parse the encrypted data
  const parts = encryptedData.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format');
  }

  const [saltB64, ivB64, authTagB64, ciphertext] = parts;

  // Decode from base64
  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  // Derive key from secret and salt
  const key = getEncryptionKey(salt);

  // Create decipher and decrypt
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if encryption is properly configured
 */
export function isEncryptionConfigured(): boolean {
  return !!process.env.MFA_ENCRYPTION_KEY;
}
