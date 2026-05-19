/** @jest-environment node */
import {
  DEVICE_CODE_WRAP_VERSION,
  decryptDeviceCodeCredentials,
  deriveDeviceCodeKey,
  encryptDeviceCodeCredentials,
} from '@/lib/deviceCodeCrypto';

describe('deviceCodeCrypto', () => {
  const deviceCode = 'a'.repeat(86); // base64url of 64 random bytes
  const docId = 'silver-compass-drift';

  it('exposes the v1 wrap version', () => {
    expect(DEVICE_CODE_WRAP_VERSION).toBe('v1');
  });

  it('derives a stable 32-byte key for matching inputs', () => {
    const a = deriveDeviceCodeKey(deviceCode, docId);
    const b = deriveDeviceCodeKey(deviceCode, docId);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it('produces different keys when deviceCode changes', () => {
    const a = deriveDeviceCodeKey(deviceCode, docId);
    const b = deriveDeviceCodeKey(deviceCode + 'x', docId);
    expect(a.equals(b)).toBe(false);
  });

  it('produces different keys when docId changes (HKDF salt)', () => {
    const a = deriveDeviceCodeKey(deviceCode, docId);
    const b = deriveDeviceCodeKey(deviceCode, 'different-phrase');
    expect(a.equals(b)).toBe(false);
  });

  it('round-trips a credential bundle', () => {
    const bundle = {
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.fake',
      refreshToken: 'rt_xxx',
      expiresIn: 3600,
      siteId: 'site-1',
    };
    const blob = encryptDeviceCodeCredentials(bundle, deviceCode, docId);
    const out = decryptDeviceCodeCredentials(blob, deviceCode, docId);
    expect(out).toEqual(bundle);
  });

  it('rejects decryption with the wrong deviceCode (auth tag fails)', () => {
    const blob = encryptDeviceCodeCredentials({ a: 1 }, deviceCode, docId);
    expect(() =>
      decryptDeviceCodeCredentials(blob, deviceCode + 'x', docId),
    ).toThrow();
  });

  it('rejects decryption with the wrong docId (HKDF salt mismatch)', () => {
    const blob = encryptDeviceCodeCredentials({ a: 1 }, deviceCode, docId);
    expect(() =>
      decryptDeviceCodeCredentials(blob, deviceCode, 'wrong-phrase'),
    ).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const blob = encryptDeviceCodeCredentials({ a: 1 }, deviceCode, docId);
    // Flip a byte deep in the ciphertext segment.
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString('base64');
    expect(() => decryptDeviceCodeCredentials(tampered, deviceCode, docId)).toThrow();
  });
});
