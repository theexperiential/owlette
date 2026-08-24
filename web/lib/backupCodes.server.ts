/**
 * Backup (recovery) code generation — server side.
 *
 * A duplicate of `generateBackupCodes` in `lib/totp.ts`, which is imported by
 * the `'use client'` `app/setup-2fa/page.tsx`. Browser-minted codes mean the
 * server never chose the recovery material it stores — entropy, length and
 * uniqueness are whatever the caller sent. Tolerable as a TOTP-enrollment
 * by-product; not tolerable now `POST /api/mfa/backup-codes` mints on demand
 * for passkey-only accounts. Every route uses THIS copy; the totp.ts one
 * survives only until the client page moves to `BackupCodesPanel`.
 *
 * Hashing deliberately stays in `lib/totp.ts` (`hashBackupCode`) — it's the
 * same one-way function `verifyBackupCode` compares against, and forking it is
 * how the two silently diverge.
 */

import crypto from 'crypto';
import { hashBackupCode } from '@/lib/totp';

/** Codes issued per generation. */
export const BACKUP_CODE_COUNT = 10;

/** Entropy bytes per code; 4 renders as the 8 hex chars users type. */
const BACKUP_CODE_BYTES = 4;

/** A minted generation: what the user sees, and what we store. */
export interface IssuedBackupCodes {
  /** Shown once — never persisted. */
  plaintext: string[];
  /** `hashBackupCode` of each entry above, same order. */
  hashed: string[];
}

/**
 * Mint `count` recovery codes in the browser copy's format (8 uppercase hex),
 * so old and new codes are indistinguishable and `verifyBackupCode` matches both.
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(BACKUP_CODE_BYTES).toString('hex').toUpperCase());
  }
  return codes;
}

/** Mint + hash in one step, so no caller can persist the plaintext half. */
export function issueBackupCodes(count: number = BACKUP_CODE_COUNT): IssuedBackupCodes {
  const plaintext = generateBackupCodes(count);
  return { plaintext, hashed: plaintext.map(hashBackupCode) };
}
