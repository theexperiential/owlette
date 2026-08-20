/**
 * Device-code credential encryption. Keeps agent/cli credentials out of the
 * polled firestore doc, where they used to sit in plaintext for the ~10-minute
 * authorise→poll window and were readable from any snapshot, backup or PITR
 * restore.
 *
 *  1. The client mints a secret 64-byte `deviceCode`, held in memory only.
 *  2. The doc carries `deviceCodeHash = sha256(deviceCode)` for lookup, plus
 *     the cleartext `deviceCode` until authorise consumes and wipes it.
 *  3. Authorise encrypts the credential JSON with AES-256-GCM under
 *     `HKDF-SHA256(deviceCode, salt=pairPhrase, info='owlette-device-code-v1')`,
 *     leaving `encryptedCredentials` + `wrapVersion` and no plaintext.
 *  4. Poll returns the blob; the client re-derives the key and decrypts.
 *
 * Someone holding only the post-authorise document has ciphertext and no key.
 * Someone holding only the `pairPhrase` can't reach poll at all — it demands
 * `deviceCode`, and the pairPhrase path (pre-authorised silent install) never
 * produces an encrypted blob.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard nonce size
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
const HKDF_INFO = 'owlette-device-code-v1';

export const DEVICE_CODE_WRAP_VERSION = 'v1';

/**
 * Per-document AES-256-GCM key from the client's secret `deviceCode` and the
 * doc id (the pair phrase). Must stay byte-identical to the python side in
 * `agent/src/auth_manager.py`.
 */
export function deriveDeviceCodeKey(deviceCode: string, docId: string): Buffer {
  if (!deviceCode || typeof deviceCode !== 'string') {
    throw new Error('deriveDeviceCodeKey: deviceCode required');
  }
  if (!docId || typeof docId !== 'string') {
    throw new Error('deriveDeviceCodeKey: docId required');
  }
  // hkdfSync returns an ArrayBuffer; the crypto APIs below want a Buffer.
  const derived = hkdfSync(
    'sha256',
    Buffer.from(deviceCode, 'utf8'),
    Buffer.from(docId, 'utf8'),
    Buffer.from(HKDF_INFO, 'utf8'),
    KEY_LENGTH,
  );
  return Buffer.from(derived);
}

/**
 * Encrypt a credential bundle to `base64(iv || authTag || ciphertext)`. The
 * output is opaque to the server — unreadable without the deviceCode.
 */
export function encryptDeviceCodeCredentials(
  credentials: Record<string, unknown>,
  deviceCode: string,
  docId: string,
): string {
  const key = deriveDeviceCodeKey(deviceCode, docId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    // aes-256-gcm should always produce a 16-byte tag.
    throw new Error(
      `unexpected auth tag length: ${authTag.length} (expected ${AUTH_TAG_LENGTH})`,
    );
  }
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Inverse of `encryptDeviceCodeCredentials`. Server-side this is test-only —
 * the agent and cli implement their own decryption with identical parameters.
 */
export function decryptDeviceCodeCredentials<T = Record<string, unknown>>(
  blob: string,
  deviceCode: string,
  docId: string,
): T {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('encrypted blob too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const key = deriveDeviceCodeKey(deviceCode, docId);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
