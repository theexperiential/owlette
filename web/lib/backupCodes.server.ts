/**
 * Backup (recovery) code generation — server side.
 *
 * WHY THIS MODULE EXISTS
 *
 * `generateBackupCodes` also lives in `lib/totp.ts`, and that copy is imported
 * by `app/setup-2fa/page.tsx` — a `'use client'` component. Codes minted in the
 * browser and POSTed to the server for hashing means the server never chose the
 * recovery material it stores: entropy, length and uniqueness are all whatever
 * the caller happened to send. That was survivable while backup codes were a
 * by-product of TOTP enrollment; it is not survivable now that
 * `POST /api/mfa/backup-codes` mints them on demand for passkey-only accounts.
 *
 * So generation is mirrored here, on the `.server.ts` side of the module
 * layout, and every route uses THIS copy. The `lib/totp.ts` one stays where it
 * is only because the client page still calls it; wave 4 adopts
 * `BackupCodesPanel` plus this route, and that import goes away with it.
 *
 * Hashing deliberately stays in `lib/totp.ts` (`hashBackupCode`): it is the
 * same one-way function `verifyBackupCode` compares against, and forking it
 * would be how the two silently diverge.
 */

import crypto from 'crypto';
import { hashBackupCode } from '@/lib/totp';

/** How many codes an account is issued per generation. */
export const BACKUP_CODE_COUNT = 10;

/** Bytes of entropy per code — 4 bytes renders as the 8 hex chars users type. */
const BACKUP_CODE_BYTES = 4;

/** A freshly minted generation: what the user sees, and what we store. */
export interface IssuedBackupCodes {
  /** Shown to the user exactly once — never persisted. */
  plaintext: string[];
  /** `hashBackupCode` of each entry above, in the same order. */
  hashed: string[];
}

/**
 * Mint `count` recovery codes.
 *
 * Matches the format the browser copy has always produced (8 uppercase hex
 * characters) so codes written down before this change and codes minted after
 * it are indistinguishable to the user — and so `verifyBackupCode` keeps
 * matching both.
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(BACKUP_CODE_BYTES).toString('hex').toUpperCase());
  }
  return codes;
}

/**
 * Mint a generation and hash it in one step, so no caller can accidentally
 * persist the plaintext half by reaching for the wrong array.
 */
export function issueBackupCodes(count: number = BACKUP_CODE_COUNT): IssuedBackupCodes {
  const plaintext = generateBackupCodes(count);
  return { plaintext, hashed: plaintext.map(hashBackupCode) };
}
