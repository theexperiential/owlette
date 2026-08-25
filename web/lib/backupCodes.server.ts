/**
 * Backup (recovery) code generation — server side.
 *
 * The only generator. `lib/totp.ts` used to carry a browser copy for the
 * `'use client'` `app/setup-2fa/page.tsx` — browser-minted codes meant the
 * server never chose the recovery material it stored, so entropy, length and
 * uniqueness were whatever the caller sent. That page moved to
 * `BackupCodesPanel` and stopped importing it, leaving a dead function that
 * still minted 32-bit codes; it has been removed rather than left as a trap.
 *
 * Hashing deliberately stays in `lib/totp.ts` (`hashBackupCode`) — it's the
 * same one-way function `verifyBackupCode` compares against, and forking it is
 * how the two silently diverge.
 */

import crypto from 'crypto';
import { hashBackupCode } from '@/lib/totp';

/** Codes issued per generation. */
export const BACKUP_CODE_COUNT = 10;

/**
 * Entropy bytes per code.
 *
 * Was 4 — eight hex characters, a 2^32 keyspace. `hashBackupCode` is a single
 * unsalted SHA-256, so a stolen `users` read (superadmin misuse, a Firestore
 * export, a leaked service account) could enumerate that space offline in
 * seconds, and with no salt one table covers every user at once. The hash gave
 * essentially none of the protection it exists to give.
 *
 * 10 bytes is 2^80 — not enumerable — which is what makes the fast unsalted
 * hash defensible here, exactly as it already is for the 256-bit API keys that
 * CodeQL flags under the same rule.
 *
 * The online path was never the exposure: `/api/mfa/verify-login` is
 * rate-limited and requires an established first-factor session.
 */
const BACKUP_CODE_BYTES = 10;

/** A minted generation: what the user sees, and what we store. */
export interface IssuedBackupCodes {
  /** Shown once — never persisted. */
  plaintext: string[];
  /** `hashBackupCode` of each entry above, same order. */
  hashed: string[];
}

/**
 * Mint `count` recovery codes as uppercase hex.
 *
 * Codes issued before the entropy bump are 8 characters and remain valid —
 * `verifyBackupCode` compares hashes, so mixed lengths coexist. Anyone still
 * holding an old sheet keeps a weak code until they regenerate, which is the
 * one thing this change does NOT fix on its own.
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
