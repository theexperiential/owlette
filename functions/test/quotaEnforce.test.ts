/**
 * Unit tests for per-site quota enforcement.
 *
 * Covers pure logic in lib/quotaLogic.ts and the dep-injected
 * orchestrators in quotaEnforce.ts with in-memory fakes.
 *
 * Tier model (billing sprint wave 0.4): core has no roost storage at all,
 * pro includes 1 TiB per site.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitUpload,
  ALARM_LEVELS,
  BETA_DEFAULT_TIER,
  newAlarmCrossings,
  reportQuota,
  resolveSiteTier,
  TIER_STORAGE_BYTES,
  type AlarmLevel,
  type QuotaState,
  type SiteTier,
} from '../src/lib/quotaLogic';
import {
  reconcileOneSite,
  runPreUploadCheck,
  type QuotaStore,
  type SiteDirectory,
  type StorageMetrics,
} from '../src/quotaEnforce';

const GB = 1024 ** 3;
const TB = 1024 ** 4;
const NOW = new Date('2026-04-20T00:00:00Z');

/* --------------------------------------------------------------------- */
/*  tier model                                                           */
/* --------------------------------------------------------------------- */

describe('tier model', () => {
  it('passes through the two known tiers', () => {
    assert.equal(resolveSiteTier('core'), 'core');
    assert.equal(resolveSiteTier('pro'), 'pro');
  });

  it('falls back to the beta default for missing/unknown values', () => {
    assert.equal(resolveSiteTier(undefined), BETA_DEFAULT_TIER);
    assert.equal(resolveSiteTier(null), BETA_DEFAULT_TIER);
    // retired plan names left on pre-billing docs land here too.
    assert.equal(resolveSiteTier('legacy-plan'), BETA_DEFAULT_TIER);
    assert.equal(resolveSiteTier(42), BETA_DEFAULT_TIER);
  });

  it('pro carries 1 TiB of included storage; core carries none', () => {
    assert.equal(TIER_STORAGE_BYTES.pro, 1_099_511_627_776);
    assert.equal(TIER_STORAGE_BYTES.core, 0);
  });
});

/* --------------------------------------------------------------------- */
/*  reportQuota                                                          */
/* --------------------------------------------------------------------- */

describe('reportQuota', () => {
  it('reports zero usage cleanly', () => {
    const r = reportQuota({ tier: 'pro', usedBytes: 0, pendingBytes: 0 });
    assert.equal(r.fractionUsed, 0);
    assert.equal(r.atCap, false);
    assert.equal(r.alarmLevel, 0);
    assert.equal(r.remainingBytes, TIER_STORAGE_BYTES.pro);
    assert.equal(r.roostAvailable, true);
  });

  it('sums used + pending toward the cap', () => {
    const r = reportQuota({
      tier: 'pro',
      usedBytes: 900 * GB,
      pendingBytes: 100 * GB,
    });
    assert.equal(r.committedBytes, 1000 * GB);
    assert.equal(r.remainingBytes, 24 * GB); // 1 TiB = 1024 GiB
    assert.equal(r.atCap, false);
  });

  it('atCap flips at exactly 100%', () => {
    const r = reportQuota({
      tier: 'pro',
      usedBytes: 1 * TB,
      pendingBytes: 0,
    });
    assert.equal(r.atCap, true);
    assert.equal(r.alarmLevel, 1.0);
  });

  it('reports alarm level 0.5 when between 50%-79%', () => {
    const r = reportQuota({
      tier: 'pro',
      usedBytes: 600 * GB, // 58.6 %
      pendingBytes: 0,
    });
    assert.equal(r.alarmLevel, 0.5);
  });

  it('reports alarm level 0.8 when between 80%-99%', () => {
    const r = reportQuota({
      tier: 'pro',
      usedBytes: 900 * GB, // 87.9 %
      pendingBytes: 0,
    });
    assert.equal(r.alarmLevel, 0.8);
  });

  it('core has no storage entitlement at all', () => {
    const r = reportQuota({ tier: 'core', usedBytes: 0, pendingBytes: 0 });
    assert.equal(r.roostAvailable, false);
    assert.equal(r.planLimitBytes, 0);
    assert.equal(r.remainingBytes, 0);
    assert.equal(r.atCap, true);
    assert.ok(Number.isNaN(r.fractionUsed));
  });

  it('core holding legacy bytes still raises no alarm (no divide-by-zero)', () => {
    // a site downgraded from pro keeps its bytes until GC; alarming on
    // every reconcile would be noise — the tier gate already denies uploads.
    const r = reportQuota({
      tier: 'core',
      usedBytes: 40 * GB,
      pendingBytes: 0,
    });
    assert.equal(r.alarmLevel, 0);
    assert.equal(r.committedBytes, 40 * GB);
    assert.equal(r.roostAvailable, false);
  });

  it('clamps negative committedBytes at 0 (defensive)', () => {
    const r = reportQuota({
      tier: 'pro',
      usedBytes: -10,
      pendingBytes: 0,
    });
    assert.equal(r.committedBytes, 0);
  });
});

/* --------------------------------------------------------------------- */
/*  newAlarmCrossings                                                    */
/* --------------------------------------------------------------------- */

describe('newAlarmCrossings', () => {
  it('empty when stationary', () => {
    assert.deepEqual(newAlarmCrossings(0.5, 0.5), []);
  });

  it('empty when going down (de-alarm does not re-fire)', () => {
    assert.deepEqual(newAlarmCrossings(0.8, 0.5), []);
  });

  it('fires only the newly-crossed thresholds', () => {
    // 0.5 → 0.8 fires only 0.8 (0.5 was already fired)
    assert.deepEqual(newAlarmCrossings(0.5, 0.8), [0.8]);
  });

  it('big jump fires every unfired threshold in order', () => {
    // 0 → 1.0 fires 0.5, 0.8, 1.0
    assert.deepEqual(newAlarmCrossings(0, 1.0), [0.5, 0.8, 1.0]);
  });

  it('all crossings land in ALARM_LEVELS (no extras, no misses)', () => {
    const crossings = newAlarmCrossings(0, 1.0);
    for (const c of crossings) assert.ok(ALARM_LEVELS.includes(c));
  });
});

/* --------------------------------------------------------------------- */
/*  admitUpload                                                          */
/* --------------------------------------------------------------------- */

describe('admitUpload', () => {
  it('admits a request that fits comfortably', () => {
    const d = admitUpload({
      state: { tier: 'pro', usedBytes: 100 * GB, pendingBytes: 0 },
      requestedBytes: 10 * GB,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.status, 200);
  });

  it('denies a core site with 403 + an upgrade-to-pro CTA', () => {
    const d = admitUpload({
      state: { tier: 'core', usedBytes: 0, pendingBytes: 0 },
      requestedBytes: 1024,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.status, 403);
    assert.equal(d.reason, 'tier_insufficient');
    assert.equal(d.upgradeCta?.currentTier, 'core');
    assert.equal(d.upgradeCta?.suggestedTier, 'pro');
  });

  it('denies an already-at-cap pro site with 402 + a free-up-space hint', () => {
    const d = admitUpload({
      state: { tier: 'pro', usedBytes: 1 * TB, pendingBytes: 0 },
      requestedBytes: 1024,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.status, 402);
    assert.equal(d.reason, 'quota_exceeded');
    assert.equal(d.upgradeCta?.currentTier, 'pro');
    // no tier above pro — the CTA is the message alone.
    assert.equal(d.upgradeCta?.suggestedTier, undefined);
    assert.match(d.upgradeCta?.message ?? '', /1 TB per site/);
  });

  it('denies a request that WOULD cross the cap with 402 + would_exceed', () => {
    const d = admitUpload({
      state: { tier: 'pro', usedBytes: 1000 * GB, pendingBytes: 0 },
      requestedBytes: 100 * GB, // 1000 + 100 > 1024
    });
    assert.equal(d.allowed, false);
    assert.equal(d.status, 402);
    assert.equal(d.reason, 'quota_would_exceed');
  });

  it('counts pending against cap so concurrent admits cannot overcommit', () => {
    // 900 GB used + 124 GB pending = 1 TiB committed; next 1 KB would exceed.
    const d = admitUpload({
      state: { tier: 'pro', usedBytes: 900 * GB, pendingBytes: 124 * GB },
      requestedBytes: 1024,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'quota_exceeded');
  });

  it('rejects non-positive requestedBytes with 400', () => {
    const d = admitUpload({
      state: { tier: 'pro', usedBytes: 0, pendingBytes: 0 },
      requestedBytes: 0,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.status, 400);
    assert.equal(d.reason, 'invalid_request');
  });
});

/* --------------------------------------------------------------------- */
/*  runPreUploadCheck orchestrator                                       */
/* --------------------------------------------------------------------- */

interface FakeQuotaState {
  read: QuotaState;
  lastAlarmLevel: AlarmLevel;
  reservations: Map<string, { bytes: number; reservedAt: Date }>;
  rewrites: Array<{ state: QuotaState; at: Date }>;
  alarmWrites: Array<{ level: AlarmLevel; crossings: AlarmLevel[]; at: Date }>;
}

function fakeDirectory(tier: SiteTier, sites: string[] = ['s']): SiteDirectory {
  return {
    async listSiteIds() { return sites; },
    async readTier() { return tier; },
  };
}

function fakeQuotaStore(state: FakeQuotaState): QuotaStore {
  return {
    async read() {
      return { state: { ...state.read }, lastAlarmLevel: state.lastAlarmLevel };
    },
    async reservePending(_siteId, id, bytes, now) {
      state.reservations.set(id, { bytes, reservedAt: now });
      state.read.pendingBytes += bytes;
    },
    async releasePending(_siteId, id) {
      const r = state.reservations.get(id);
      if (r) {
        state.reservations.delete(id);
        state.read.pendingBytes -= r.bytes;
      }
    },
    async rewrite(_siteId, next, now) {
      state.read = { ...next };
      state.rewrites.push({ state: { ...next }, at: now });
    },
    async recordAlarms(_siteId, level, crossings, at) {
      state.lastAlarmLevel = level;
      state.alarmWrites.push({ level, crossings, at });
    },
  };
}

function fakeMetrics(bytes: number): StorageMetrics {
  return { async usedBytes() { return bytes; } };
}

describe('runPreUploadCheck', () => {
  it('admits a valid request and reserves pending', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 100 * GB, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 10 * GB },
      {
        directory: fakeDirectory('pro'),
        quota: fakeQuotaStore(state),
        now: () => NOW,
      },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.allowed, true);
    assert.equal(r.body.planLimitBytes, TIER_STORAGE_BYTES.pro);
    assert.equal(state.reservations.get('u-1')?.bytes, 10 * GB);
  });

  it('denies at-cap with 402 + free-up-space hint; does NOT reserve', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 1 * TB, pendingBytes: 0 },
      lastAlarmLevel: 1.0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 1024 },
      {
        directory: fakeDirectory('pro'),
        quota: fakeQuotaStore(state),
        now: () => NOW,
      },
    );
    assert.equal(r.status, 402);
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.upgrade?.currentTier, 'pro');
    assert.equal(state.reservations.size, 0);
  });

  it('denies a core site with 403 + upgrade CTA; does NOT reserve', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'core', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 1024 },
      {
        directory: fakeDirectory('core'),
        quota: fakeQuotaStore(state),
        now: () => NOW,
      },
    );
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'tier_insufficient');
    assert.equal(r.body.upgrade?.suggestedTier, 'pro');
    assert.equal(state.reservations.size, 0);
  });

  it('rejects malformed requests with 400', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: '', reservationId: '', requestedBytes: 0 },
      {
        directory: fakeDirectory('pro'),
        quota: fakeQuotaStore(state),
      },
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'invalid_request');
  });

  it('uses directory-authoritative tier even if cached state disagrees', async () => {
    // cached quota doc still says 'pro' but the site doc says 'core' →
    // enforce core (a downgrade must take effect immediately).
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 1024 },
      {
        directory: fakeDirectory('core'),
        quota: fakeQuotaStore(state),
      },
    );
    assert.equal(r.status, 403);
    assert.equal(r.body.allowed, false);
  });
});

/* --------------------------------------------------------------------- */
/*  reconcileOneSite                                                     */
/* --------------------------------------------------------------------- */

describe('reconcileOneSite', () => {
  it('does not fire alarms when usage stays below 50%', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const result = await reconcileOneSite('s', {
      directory: fakeDirectory('pro'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(400 * GB), // 39 %
      now: () => NOW,
    });
    assert.equal(result?.crossings.length, 0);
    assert.equal(state.alarmWrites.length, 0);
  });

  it('fires 50% alarm when crossing the threshold', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('pro'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(600 * GB), // 58.6 %
      now: () => NOW,
    });
    assert.deepEqual(r?.crossings, [0.5]);
    assert.equal(state.alarmWrites.length, 1);
  });

  it('fires every unfired level on a big jump (0 → 100%)', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('pro'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(1 * TB),
      now: () => NOW,
    });
    assert.deepEqual(r?.crossings, [0.5, 0.8, 1.0]);
  });

  it('does not refire when usage stays at the same alarm level', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'pro', usedBytes: 900 * GB, pendingBytes: 0 },
      lastAlarmLevel: 0.8, // already at 80% alarm
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('pro'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(950 * GB), // still in 80% band
      now: () => NOW,
    });
    assert.equal(r?.crossings.length, 0);
    assert.equal(state.alarmWrites.length, 0);
  });

  it('never alarms a core site (no entitlement to exhaust)', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'core', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('core'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(40 * GB), // legacy bytes from a downgrade
      now: () => NOW,
    });
    assert.equal(r?.currentLevel, 0);
    assert.equal(r?.crossings.length, 0);
    assert.equal(r?.planLimitBytes, 0);
    assert.equal(state.alarmWrites.length, 0);
  });
});
