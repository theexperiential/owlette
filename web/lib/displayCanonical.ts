/**
 * Canonical identity-only hashing for display monitors.
 *
 * MUST produce byte-identical output to the Python side:
 *   payload = `${manufacturer}|${product_code}|${serial}`
 *   hash    = sha1(payload).hex[:16]
 * `product_code` is the EDID *integer*; monitor docs persist it as zero-padded
 * hex ("000A"), so parse back to int before stringifying to match Python's
 * `'{0}'.format(int)`.
 *
 * Old agents folded the friendly name into the payload, which drifted whenever
 * Windows renamed a monitor during a driver state transition (RDP attach,
 * sleep). Re-deriving on read lets legacy-scheme layouts match current live
 * hashes with no Firestore migration.
 */

import type { MonitorInfo } from '@/hooks/useDisplayState';

type WithIdentity = Pick<
  MonitorInfo,
  'manufacturerId' | 'productCode' | 'serialNumber'
>;

function productCodeToInt(productCode: string | undefined | null): number {
  if (!productCode) return 0;
  const parsed = parseInt(String(productCode), 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasIdentity(m: WithIdentity): boolean {
  const mfg = m.manufacturerId || '';
  const pc = productCodeToInt(m.productCode);
  const serial = m.serialNumber || '';
  return Boolean(mfg) || pc !== 0 || Boolean(serial);
}

async function sha1Hex16(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  let hex = '';
  for (const b of new Uint8Array(digest)) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex.slice(0, 16);
}

export async function canonicalEdidHash(
  m: WithIdentity & { edidHash?: string },
): Promise<string> {
  // Keep the original when identity is missing — hashing empty fields would
  // collapse every unknown monitor onto one hash.
  if (!hasIdentity(m)) return m.edidHash || '';
  const mfg = m.manufacturerId || '';
  const pc = productCodeToInt(m.productCode);
  const serial = m.serialNumber || '';
  const payload = `${mfg}|${pc}|${serial}`;
  return sha1Hex16(payload);
}

export async function canonicalizeMonitors<T extends WithIdentity & { edidHash?: string }>(
  monitors: T[] | undefined | null,
): Promise<T[]> {
  if (!monitors || monitors.length === 0) return [];
  const hashes = await Promise.all(monitors.map(canonicalEdidHash));
  return monitors.map((m, i) => ({ ...m, edidHash: hashes[i] }));
}
