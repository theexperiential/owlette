/** @jest-environment node */

import { webcrypto } from 'crypto';
import { createHash } from 'crypto';

// Web Crypto is a browser/jsdom global but the `@jest-environment node`
// runner doesn't expose it by default. Polyfill before importing the module
// under test so its top-level `crypto.subtle` reference resolves. TextEncoder
// is a real Node global since 11+ so no polyfill needed there.
if (!('crypto' in globalThis)) {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import { canonicalEdidHash, canonicalizeMonitors } from '@/lib/displayCanonical';
import type { MonitorInfo } from '@/hooks/useDisplayState';

/** Mirror of agent/src/display_manager.py:_edid_hash — used as the parity
 *  oracle so the JS implementation can't silently drift away from Python.
 */
function pythonEquivalentHash(mfg: string, productCodeInt: number, serial: string): string {
  const payload = `${mfg}|${productCodeInt}|${serial}`;
  return createHash('sha1').update(payload, 'utf-8').digest('hex').slice(0, 16);
}

function monitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: 'a:1',
    edidHash: 'placeholder',
    manufacturerId: 'DEL',
    productCode: '40F2',
    serialNumber: '5&abc&0&UID257',
    friendlyName: 'DELL U2415',
    position: { x: 0, y: 0 },
    resolution: { width: 1920, height: 1200 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: true,
    connectionType: 'dp',
    adapterLuid: 'a',
    targetId: 1,
    ...overrides,
  };
}

describe('canonicalEdidHash', () => {
  it('matches the Python identity hash byte-for-byte', async () => {
    const m = monitor();
    const got = await canonicalEdidHash(m);
    const want = pythonEquivalentHash('DEL', 0x40f2, '5&abc&0&UID257');
    expect(got).toBe(want);
    expect(got).toHaveLength(16);
  });

  it('is identical regardless of friendlyName (the whole point)', async () => {
    const h1 = await canonicalEdidHash(monitor({ friendlyName: 'DELL U2415' }));
    const h2 = await canonicalEdidHash(monitor({ friendlyName: 'SAMSUNG' }));
    const h3 = await canonicalEdidHash(monitor({ friendlyName: '' }));
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('handles productCode hex variants identically', async () => {
    // Agent emits 4-char zero-padded uppercase ("40F2"). Defensive against
    // mixed-case or 0x-prefixed variants leaking in from older docs.
    const cases = ['40F2', '40f2', '0040F2'];
    const hashes = await Promise.all(
      cases.map((pc) => canonicalEdidHash(monitor({ productCode: pc }))),
    );
    expect(new Set(hashes).size).toBe(1);
  });

  it('preserves existing hash when identity fields are empty', async () => {
    const m = monitor({
      edidHash: 'kept',
      manufacturerId: '',
      productCode: '',
      serialNumber: '',
    });
    expect(await canonicalEdidHash(m)).toBe('kept');
  });

  it('treats missing productCode as 0 (matches Python branch)', async () => {
    const got = await canonicalEdidHash(monitor({ productCode: '' }));
    const want = pythonEquivalentHash('DEL', 0, '5&abc&0&UID257');
    expect(got).toBe(want);
  });
});

describe('canonicalizeMonitors', () => {
  it('rewrites every monitor hash from its own raw fields', async () => {
    const legacy: MonitorInfo[] = [
      monitor({ id: 'a:1', edidHash: 'old_format_one' }),
      monitor({
        id: 'a:2',
        edidHash: 'old_format_two',
        manufacturerId: 'SAM',
        productCode: 'ABCD',
        serialNumber: '5&xyz&0&UID258',
      }),
    ];
    const canon = await canonicalizeMonitors(legacy);
    expect(canon).toHaveLength(2);
    expect(canon[0].edidHash).toBe(
      pythonEquivalentHash('DEL', 0x40f2, '5&abc&0&UID257'),
    );
    expect(canon[1].edidHash).toBe(
      pythonEquivalentHash('SAM', 0xabcd, '5&xyz&0&UID258'),
    );
    // Non-identity fields untouched.
    expect(canon[0].friendlyName).toBe('DELL U2415');
    expect(canon[0].position).toEqual({ x: 0, y: 0 });
  });

  it('is idempotent', async () => {
    const monitors = [monitor()];
    const once = await canonicalizeMonitors(monitors);
    const twice = await canonicalizeMonitors(once);
    expect(twice[0].edidHash).toBe(once[0].edidHash);
  });

  it('returns [] on null/undefined/empty', async () => {
    expect(await canonicalizeMonitors(null)).toEqual([]);
    expect(await canonicalizeMonitors(undefined)).toEqual([]);
    expect(await canonicalizeMonitors([])).toEqual([]);
  });
});
