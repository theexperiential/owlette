/**
 * Unit tests for per-customer quota enforcement (roost wave 2b.5).
 *
 * Covers pure logic in lib/quotaLogic.ts and the dep-injected
 * orchestrators in quotaEnforce.ts with in-memory fakes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitUpload,
  ALARM_LEVELS,
  newAlarmCrossings,
  PLAN_LIMITS_BYTES,
  reportQuota,
  type AlarmLevel,
  type PlanTier,
  type QuotaState,
} from '../src/lib/quotaLogic';
import {
  reconcileOneSite,
  runPreUploadCheck,
  type QuotaStore,
  type SiteDirectory,
  type StorageMetrics,
} from '../src/quotaEnforce';

const GB = 1024 ** 3;
const NOW = new Date('2026-04-20T00:00:00Z');

/* --------------------------------------------------------------------- */
/*  reportQuota                                                          */
/* --------------------------------------------------------------------- */

describe('reportQuota', () => {
  it('reports zero usage cleanly', () => {
    const r = reportQuota({ tier: 'free', usedBytes: 0, pendingBytes: 0 });
    assert.equal(r.fractionUsed, 0);
    assert.equal(r.atCap, false);
    assert.equal(r.alarmLevel, 0);
    assert.equal(r.remainingBytes, PLAN_LIMITS_BYTES.free);
  });

  it('sums used + pending toward the cap', () => {
    const r = reportQuota({
      tier: 'free',
      usedBytes: 3 * GB,
      pendingBytes: 1 * GB,
    });
    assert.equal(r.committedBytes, 4 * GB);
    assert.equal(r.remainingBytes, 1 * GB);
    assert.equal(r.atCap, false);
  });

  it('atCap flips at exactly 100%', () => {
    const r = reportQuota({
      tier: 'free',
      usedBytes: 5 * GB,
      pendingBytes: 0,
    });
    assert.equal(r.atCap, true);
    assert.equal(r.alarmLevel, 1.0);
  });

  it('reports alarm level 0.5 when between 50%-79%', () => {
    const r = reportQuota({
      tier: 'free',
      usedBytes: 3.5 * GB,
      pendingBytes: 0,
    });
    assert.equal(r.alarmLevel, 0.5);
  });

  it('reports alarm level 0.8 when between 80%-99%', () => {
    const r = reportQuota({
      tier: 'free',
      usedBytes: 4.5 * GB,
      pendingBytes: 0,
    });
    assert.equal(r.alarmLevel, 0.8);
  });

  it('enterprise = unlimited; no alarms, no atCap', () => {
    const r = reportQuota({
      tier: 'enterprise',
      usedBytes: 100 * GB,
      pendingBytes: 0,
    });
    assert.equal(r.unlimited, true);
    assert.equal(r.atCap, false);
    assert.equal(r.remainingBytes, Infinity);
    assert.ok(Number.isNaN(r.fractionUsed));
  });

  it('clamps negative committedBytes at 0 (defensive)', () => {
    const r = reportQuota({
      tier: 'free',
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
      state: { tier: 'free', usedBytes: 1 * GB, pendingBytes: 0 },
      requestedBytes: 1 * GB,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.status, 200);
  });

  it('denies an already-at-cap site with 402 + upgrade CTA', () => {
    const d = admitUpload({
      state: { tier: 'free', usedBytes: 5 * GB, pendingBytes: 0 },
      requestedBytes: 1024,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.status, 402);
    assert.equal(d.reason, 'quota_exceeded');
    assert.equal(d.upgradeCta?.currentTier, 'free');
    assert.equal(d.upgradeCta?.suggestedTier, 'starter');
  });

  it('denies a request that WOULD cross the cap with 402 + would_exceed', () => {
    const d = admitUpload({
      state: { tier: 'free', usedBytes: 4 * GB, pendingBytes: 0 },
      requestedBytes: 2 * GB, // 4 + 2 = 6 > 5
    });
    assert.equal(d.allowed, false);
    assert.equal(d.status, 402);
    assert.equal(d.reason, 'quota_would_exceed');
  });

  it('suggests the cheapest tier that accommodates the target size', () => {
    // starter=25GB, pro=100GB. needing 30GB → skip starter, suggest pro.
    const d = admitUpload({
      state: { tier: 'free', usedBytes: 30 * GB, pendingBytes: 0 },
      requestedBytes: 1024,
    });
    assert.equal(d.upgradeCta?.suggestedTier, 'pro');
  });

  it('suggests enterprise when even pro tier cannot hold the target', () => {
    const d = admitUpload({
      state: { tier: 'pro', usedBytes: 200 * GB, pendingBytes: 0 },
      requestedBytes: 1024,
    });
    assert.equal(d.upgradeCta?.suggestedTier, 'enterprise');
  });

  it('enterprise is always admitted', () => {
    const d = admitUpload({
      state: { tier: 'enterprise', usedBytes: 10_000 * GB, pendingBytes: 0 },
      requestedBytes: 1_000 * GB,
    });
    assert.equal(d.allowed, true);
  });

  it('counts pending against cap so concurrent admits cannot overcommit', () => {
    // 3 GB used + 2 GB pending = 5 GB committed; next 1 KB would exceed.
    const d = admitUpload({
      state: { tier: 'free', usedBytes: 3 * GB, pendingBytes: 2 * GB },
      requestedBytes: 1024,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'quota_exceeded');
  });

  it('rejects non-positive requestedBytes with 400', () => {
    const d = admitUpload({
      state: { tier: 'free', usedBytes: 0, pendingBytes: 0 },
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

function fakeDirectory(tier: PlanTier, sites: string[] = ['s']): SiteDirectory {
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
      read: { tier: 'free', usedBytes: 1 * GB, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 1 * GB },
      {
        directory: fakeDirectory('free'),
        quota: fakeQuotaStore(state),
        now: () => NOW,
      },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.allowed, true);
    assert.equal(state.reservations.get('u-1')?.bytes, 1 * GB);
  });

  it('denies at-cap with 402 + upgrade hint; does NOT reserve', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'free', usedBytes: 5 * GB, pendingBytes: 0 },
      lastAlarmLevel: 1.0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 1024 },
      {
        directory: fakeDirectory('free'),
        quota: fakeQuotaStore(state),
        now: () => NOW,
      },
    );
    assert.equal(r.status, 402);
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.upgrade?.suggestedTier, 'starter');
    assert.equal(state.reservations.size, 0);
  });

  it('rejects malformed requests with 400', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'free', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: '', reservationId: '', requestedBytes: 0 },
      {
        directory: fakeDirectory('free'),
        quota: fakeQuotaStore(state),
      },
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'invalid_request');
  });

  it('uses directory-authoritative tier even if cached state disagrees', async () => {
    // cached state says 'enterprise' but billing says 'free' → enforce free.
    const state: FakeQuotaState = {
      read: { tier: 'enterprise', usedBytes: 5 * GB, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await runPreUploadCheck(
      { siteId: 's', reservationId: 'u-1', requestedBytes: 1024 },
      {
        directory: fakeDirectory('free'),
        quota: fakeQuotaStore(state),
      },
    );
    assert.equal(r.status, 402);
    assert.equal(r.body.allowed, false);
  });
});

/* --------------------------------------------------------------------- */
/*  reconcileOneSite                                                     */
/* --------------------------------------------------------------------- */

describe('reconcileOneSite', () => {
  it('does not fire alarms when usage stays below 50%', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'free', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const result = await reconcileOneSite('s', {
      directory: fakeDirectory('free'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(1 * GB),
      now: () => NOW,
    });
    assert.equal(result?.crossings.length, 0);
    assert.equal(state.alarmWrites.length, 0);
  });

  it('fires 50% alarm when crossing the threshold', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'free', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('free'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(3 * GB),
      now: () => NOW,
    });
    assert.deepEqual(r?.crossings, [0.5]);
    assert.equal(state.alarmWrites.length, 1);
  });

  it('fires every unfired level on a big jump (0 → 100%)', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'free', usedBytes: 0, pendingBytes: 0 },
      lastAlarmLevel: 0,
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('free'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(5 * GB),
      now: () => NOW,
    });
    assert.deepEqual(r?.crossings, [0.5, 0.8, 1.0]);
  });

  it('does not refire when usage stays at the same alarm level', async () => {
    const state: FakeQuotaState = {
      read: { tier: 'free', usedBytes: 4.6 * GB, pendingBytes: 0 },
      lastAlarmLevel: 0.8, // already at 80% alarm
      reservations: new Map(),
      rewrites: [],
      alarmWrites: [],
    };
    const r = await reconcileOneSite('s', {
      directory: fakeDirectory('free'),
      quota: fakeQuotaStore(state),
      metrics: fakeMetrics(4.7 * GB), // still in 80% band
      now: () => NOW,
    });
    assert.equal(r?.crossings.length, 0);
    assert.equal(state.alarmWrites.length, 0);
  });
});
