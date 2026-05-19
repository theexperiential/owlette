/**
 * Canonical identity-only hashing for display monitors.
 *
 * The agent hashes (manufacturerId, productCode, serialNumber) as SHA-1 and
 * truncates to 16 hex chars to produce `edidHash`. Older agents also folded
 * the monitor friendly name into the payload, which made the hash drift on
 * the same physical monitor whenever Windows reported a different name
 * during a driver state transition (RDP attach/detach, monitor sleep, etc.).
 *
 * Hashes stored in Firestore before the agent dropped friendly-name still
 * appear with the old format. We re-derive on read so a layout captured
 * under the old scheme matches live identity hashes from a current agent —
 * no Firestore migration needed.
 *
 * This helper must produce the exact same bytes the Python side produces:
 *   payload = `${manufacturer}|${product_code}|${serial}`
 *   hash    = sha1(payload).hex[:16]
 * `product_code` is the *integer* from the EDID. Monitor docs persist it
 * as a zero-padded hex string ("000A"); we parse it back to int before
 * stringifying to match Python's `'{0}'.format(int)` representation.
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
  // Preserve the original hash when no identity is available — recomputing
  // from empty fields would collapse every unknown monitor to one hash.
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
