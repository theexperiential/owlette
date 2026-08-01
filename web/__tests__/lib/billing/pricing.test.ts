/**
 * Unit tests for `web/lib/billing/pricing.ts` (billing-system wave 2.5).
 *
 * This module is the only place the customer's money is computed, and both the
 * billing tab and the metered usage cron read from it. The cases below pin the
 * three things a silent regression would get wrong and nobody would notice
 * until an invoice went out:
 *
 *   - the pro 3-machine minimum (a billing calculation, not a gate),
 *   - the storage overage rate and the *binary* GB divisor it is measured on,
 *   - the 7-day active-machine window, including that an unreadable heartbeat
 *     costs us the line item rather than billing the customer.
 */

import {
  ACTIVE_MACHINE_WINDOW_DAYS,
  ACTIVE_MACHINE_WINDOW_MS,
  BYTES_PER_GB,
  PRO_MINIMUM_MACHINES,
  STORAGE_OVERAGE_USD_PER_GB,
  TIER_PRICES_USD,
  billableMachines,
  formatUsd,
  heartbeatToMillis,
  includedStorageBytes,
  isMachineActive,
  projectAccountBill,
  projectSiteBill,
  roundUsd,
  storageOverageBytes,
  storageOverageUsd,
} from '@/lib/billing/pricing';
import { TIER_STORAGE_BYTES } from '@/lib/siteTier';

const TIB = 1024 ** 4;
const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('pricing constants', () => {
  it('matches the prices the marketing page quotes', () => {
    expect(TIER_PRICES_USD).toEqual({ core: 10, pro: 50 });
    expect(PRO_MINIMUM_MACHINES).toBe(3);
    expect(STORAGE_OVERAGE_USD_PER_GB).toBe(0.05);
  });

  it('measures overage on binary GB, matching the binary included allowance', () => {
    // The included allowance is 1 TiB (1024^4). Pricing the overage on decimal
    // GB (1e9) would put a ~7% error into every overage line.
    expect(BYTES_PER_GB).toBe(1024 ** 3);
    expect(includedStorageBytes('pro')).toBe(TIB);
    expect(includedStorageBytes('pro')).toBe(TIER_STORAGE_BYTES.pro);
    expect(includedStorageBytes('core')).toBe(0);
  });

  it('bills machines seen in the last 7 days', () => {
    expect(ACTIVE_MACHINE_WINDOW_DAYS).toBe(7);
    expect(ACTIVE_MACHINE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('billableMachines', () => {
  it('bills core for exactly what is running', () => {
    expect(billableMachines('core', 0)).toBe(0);
    expect(billableMachines('core', 1)).toBe(1);
    expect(billableMachines('core', 12)).toBe(12);
  });

  it('applies the 3-machine floor on pro', () => {
    expect(billableMachines('pro', 0)).toBe(3);
    expect(billableMachines('pro', 1)).toBe(3);
    expect(billableMachines('pro', 2)).toBe(3);
    expect(billableMachines('pro', 3)).toBe(3);
  });

  it('bills above the floor once the fleet exceeds it', () => {
    expect(billableMachines('pro', 4)).toBe(4);
    expect(billableMachines('pro', 40)).toBe(40);
  });

  it('never bills a negative or fractional machine', () => {
    expect(billableMachines('core', -5)).toBe(0);
    expect(billableMachines('core', 2.9)).toBe(2);
    expect(billableMachines('core', Number.NaN)).toBe(0);
    expect(billableMachines('pro', Number.NaN)).toBe(3);
  });
});

describe('storage overage', () => {
  it('is zero at or below the included allowance', () => {
    expect(storageOverageBytes('pro', 0)).toBe(0);
    expect(storageOverageBytes('pro', TIB / 2)).toBe(0);
    expect(storageOverageBytes('pro', TIB)).toBe(0);
    expect(storageOverageUsd('pro', TIB)).toBe(0);
  });

  it('charges $0.05 per binary GB past the allowance', () => {
    expect(storageOverageBytes('pro', TIB + 100 * BYTES_PER_GB)).toBe(100 * BYTES_PER_GB);
    // 100 GB over × $0.05 = $5.00
    expect(storageOverageUsd('pro', TIB + 100 * BYTES_PER_GB)).toBe(5);
    // 1 GB over × $0.05 = $0.05
    expect(storageOverageUsd('pro', TIB + BYTES_PER_GB)).toBe(0.05);
  });

  it('ignores garbage byte counts rather than inventing a charge', () => {
    expect(storageOverageBytes('pro', -1)).toBe(0);
    expect(storageOverageBytes('pro', Number.NaN)).toBe(0);
    expect(storageOverageUsd('pro', Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('projectSiteBill', () => {
  it('prices a core site per running machine with no storage line', () => {
    const p = projectSiteBill({ siteId: 's1', tier: 'core', activeMachineCount: 4 });
    expect(p).toMatchObject({
      siteId: 's1',
      tier: 'core',
      activeMachineCount: 4,
      billableMachines: 4,
      machinesUsd: 40,
      storageOverageUsd: 0,
      monthlyUsd: 40,
    });
  });

  it('prices a 1-machine pro site at the 3-machine minimum', () => {
    const p = projectSiteBill({ siteId: 's1', tier: 'pro', activeMachineCount: 1 });
    expect(p.activeMachineCount).toBe(1);
    expect(p.billableMachines).toBe(3);
    expect(p.machinesUsd).toBe(150);
    expect(p.monthlyUsd).toBe(150);
  });

  it('adds storage overage to a pro site total', () => {
    const p = projectSiteBill({
      siteId: 's1',
      tier: 'pro',
      activeMachineCount: 5,
      storageBytes: TIB + 200 * BYTES_PER_GB,
    });
    expect(p.machinesUsd).toBe(250);
    expect(p.storageOverageBytes).toBe(200 * BYTES_PER_GB);
    expect(p.storageOverageUsd).toBe(10);
    expect(p.monthlyUsd).toBe(260);
  });

  it('never bills a core site for storage it can no longer use', () => {
    // roost is pro-only, so bytes on a core site are pre-downgrade leftovers.
    // The allowance is 0, which would otherwise make every byte overage.
    const p = projectSiteBill({
      siteId: 's1',
      tier: 'core',
      activeMachineCount: 2,
      storageBytes: 500 * BYTES_PER_GB,
    });
    expect(p.storageOverageBytes).toBe(0);
    expect(p.storageOverageUsd).toBe(0);
    expect(p.monthlyUsd).toBe(20);
  });

  it('distinguishes "no storage used" from "no usage data yet"', () => {
    expect(projectSiteBill({ siteId: 's1', tier: 'pro', activeMachineCount: 3 }).storageBytes)
      .toBeNull();
    expect(
      projectSiteBill({ siteId: 's1', tier: 'pro', activeMachineCount: 3, storageBytes: 0 })
        .storageBytes,
    ).toBe(0);
  });

  it('resolves an unknown tier field through getSiteTier', () => {
    // Legacy site docs carry no `tier`; the read-path fallback is pro.
    const p = projectSiteBill({ siteId: 's1', activeMachineCount: 1 });
    expect(p.tier).toBe('pro');
    expect(p.billableMachines).toBe(3);
  });
});

describe('projectAccountBill', () => {
  it('sums a mixed portfolio', () => {
    const bill = projectAccountBill([
      { siteId: 'core-site', tier: 'core', activeMachineCount: 3 },
      { siteId: 'pro-small', tier: 'pro', activeMachineCount: 1 },
      {
        siteId: 'pro-big',
        tier: 'pro',
        activeMachineCount: 10,
        storageBytes: TIB + 20 * BYTES_PER_GB,
      },
    ]);

    expect(bill.perSite).toHaveLength(3);
    // 3 × $10 + max(3,1) × $50 + 10 × $50 + 20 GB × $0.05
    expect(bill.totalUsd).toBe(30 + 150 + 500 + 1);
  });

  it('returns a valid zero bill for an account with no sites', () => {
    expect(projectAccountBill([])).toEqual({ perSite: [], totalUsd: 0 });
  });

  it('rounds the total to whole cents', () => {
    const bill = projectAccountBill([
      { siteId: 'a', tier: 'pro', activeMachineCount: 3, storageBytes: TIB + BYTES_PER_GB / 3 },
      { siteId: 'b', tier: 'pro', activeMachineCount: 3, storageBytes: TIB + BYTES_PER_GB / 3 },
    ]);
    expect(bill.totalUsd).toBe(roundUsd(bill.totalUsd));
    expect(String(bill.totalUsd)).not.toMatch(/\.\d{3,}/);
  });
});

describe('isMachineActive', () => {
  const insideWindow = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000);
  const outsideWindow = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);

  it('counts a machine that checked in inside the window', () => {
    expect(isMachineActive(insideWindow, NOW)).toBe(true);
  });

  it('drops a machine silent for longer than the window', () => {
    expect(isMachineActive(outsideWindow, NOW)).toBe(false);
  });

  it('includes a heartbeat landing exactly on the boundary', () => {
    expect(isMachineActive(new Date(NOW.getTime() - ACTIVE_MACHINE_WINDOW_MS), NOW)).toBe(true);
    expect(isMachineActive(new Date(NOW.getTime() - ACTIVE_MACHINE_WINDOW_MS - 1), NOW)).toBe(false);
  });

  it('does not bill a machine whose heartbeat cannot be read', () => {
    // The customer-favourable direction: an unparseable timestamp costs us the
    // line item rather than charging for a machine we cannot prove exists.
    expect(isMachineActive(null, NOW)).toBe(false);
    expect(isMachineActive(undefined, NOW)).toBe(false);
    expect(isMachineActive('not-a-date', NOW)).toBe(false);
  });

  it('accepts every timestamp shape a machine doc can carry', () => {
    const ms = insideWindow.getTime();
    expect(isMachineActive({ toMillis: () => ms }, NOW)).toBe(true);
    expect(isMachineActive({ seconds: Math.floor(ms / 1000) }, NOW)).toBe(true);
    expect(isMachineActive({ _seconds: Math.floor(ms / 1000) }, NOW)).toBe(true);
    expect(isMachineActive(ms, NOW)).toBe(true);
    expect(isMachineActive(insideWindow.toISOString(), NOW)).toBe(true);
  });
});

describe('heartbeatToMillis', () => {
  it('returns milliseconds, not the seconds the client hook uses', () => {
    const d = new Date('2026-07-04T00:00:00.000Z');
    expect(heartbeatToMillis(d)).toBe(d.getTime());
    expect(heartbeatToMillis({ seconds: d.getTime() / 1000 })).toBe(d.getTime());
  });

  it('returns null for anything it cannot read as a time', () => {
    expect(heartbeatToMillis(null)).toBeNull();
    expect(heartbeatToMillis(undefined)).toBeNull();
    expect(heartbeatToMillis(Number.NaN)).toBeNull();
    expect(heartbeatToMillis('nope')).toBeNull();
    expect(
      heartbeatToMillis({
        toMillis: () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
  });
});

describe('formatUsd', () => {
  it('drops trailing cents on whole amounts', () => {
    expect(formatUsd(150)).toBe('$150');
    expect(formatUsd(0)).toBe('$0');
  });

  it('shows cents only when there are cents', () => {
    expect(formatUsd(150.5)).toBe('$150.50');
    expect(formatUsd(0.05)).toBe('$0.05');
  });

  it('never leaks float noise', () => {
    expect(formatUsd(149.99999999999997)).toBe('$150');
  });
});
