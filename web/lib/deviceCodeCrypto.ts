/**
 * Device-code credential encryption.
 *
 * The device-code pairing flow returns sensitive credentials (firebase
 * id/refresh tokens for the agent, owk_* api keys for the cli) via a
 * polled firestore document. Historically those credentials lived in
 * the document in plaintext for the ~10-minute window between authorise
 * and poll. Anyone with firestore read access during that window — a
 * leaked superadmin session, a snapshot, a backup, a PITR restore — saw
 * raw credentials.
 *
 * The fix:
 *
 *  1. The client (agent installer / cli) generates a 64-byte opaque
 *     `deviceCode` and keeps it secret in process memory.
 *  2. The server stores `deviceCodeHash = sha256(deviceCode)` on the
 *     firestore doc for hash-based lookup, AND stores the cleartext
 *     `deviceCode` on the same doc only until the user authorises (it
 *     is consumed and wiped during the authorise transaction).
 *  3. At authorise time the server packs the credentials into a JSON
 *     blob and encrypts it with `AES-256-GCM`, using a key derived via
 *     `HKDF-SHA256(deviceCode, salt=pairPhrase, info='owlette-device-code-v1')`.
 *     The doc now holds `encryptedCredentials` + `wrapVersion: 'v1'`
 *     and **no plaintext credential fields** — the cleartext deviceCode
 *     is wiped in the same transaction.
 *  4. Poll returns the encrypted blob. The client re-derives the same
 *     HKDF key from its own copy of `deviceCode` and decrypts in
 *     process memory. The blob never leaves the wire encrypted.
 *
 * An attacker that sees ONLY the firestore document after authorise
 * has the ciphertext but no key material. An attacker that sees only
 * the `pairPhrase` (e.g. shoulder-surfs the installer screen) cannot
 * even reach the poll endpoint with credentials — poll demands
 * `deviceCode`, and the only path that accepts `pairPhrase` is the
 * pre-authorised silent-install flow which never produces an encrypted
 * blob (no client holds the key).
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
 * Derive the per-document AES-256-GCM key from the polling client's
 * secret `deviceCode` and the document id (the pair phrase).
 *
 * Both the authorise endpoint and the polling client must compute this
 * with identical inputs to interoperate. The matching python
 * implementation is in `agent/src/auth_manager.py`.
 */
export function deriveDeviceCodeKey(deviceCode: string, docId: string): Buffer {
  if (!deviceCode || typeof deviceCode !== 'string') {
    throw new Error('deriveDeviceCodeKey: deviceCode required');
  }
  if (!docId || typeof docId !== 'string') {
    throw new Error('deriveDeviceCodeKey: docId required');
  }
  // hkdfSync returns an ArrayBuffer; wrap into a Buffer for the
  // crypto APIs that follow.
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
 * Encrypt a credential bundle as a single base64 string of the form
 * `base64(iv || authTag || ciphertext)`.
 *
 * Callers pass the cleartext credential object; this helper handles
 * serialisation. The output is opaque to the server once written — it
 * is not introspectable without the deviceCode.
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
    // Defensive: aes-256-gcm should always produce a 16-byte tag.
    throw new Error(
      `unexpected auth tag length: ${authTag.length} (expected ${AUTH_TAG_LENGTH})`,
    );
  }
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt an `encryptDeviceCodeCredentials` blob back into the cleartext
 * credential object. Used only by tests on the server side; the
 * production agent / cli clients implement their own decryption with
 * identical parameters (python `cryptography` / node `crypto`
 * respectively).
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
