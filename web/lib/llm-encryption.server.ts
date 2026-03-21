/**
 * Server-side encryption utilities for LLM API keys.
 *
 * Uses AES-256-GCM for authenticated encryption.
 * Key is derived from LLM_ENCRYPTION_KEY environment variable.
 * Falls back to MFA_ENCRYPTION_KEY if LLM_ENCRYPTION_KEY is not set.
 *
 * IMPORTANT: This file should only be imported in server components/API routes.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey(salt: Buffer): Buffer {
  const secret = process.env.LLM_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error(
      'LLM_ENCRYPTION_KEY (or MFA_ENCRYPTION_KEY fallback) environment variable is not set'
    );
  }

  return scryptSync(secret, salt, KEY_LENGTH);
}

export function encryptApiKey(plaintext: string): string {
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

export function decryptApiKey(encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted API key format');
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

export function isLlmEncryptionConfigured(): boolean {
  return !!(process.env.LLM_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY);
}
