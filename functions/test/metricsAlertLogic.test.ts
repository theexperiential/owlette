/**
 * Unit tests for metric-threshold alert freshness gating.
 *
 * Regression guarded: an offline machine's frozen metrics were re-evaluated
 * every time an unrelated write (e.g. the health-check cron) re-triggered
 * onMetricsWrite, re-firing "disk 87.2% > 85" hourly for a machine that had
 * been offline for a week. The gate skips sample + alert eval when telemetry is
 * stale.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_METRICS_MS,
  telemetryAgeMs,
  isTelemetryStale,
} from '../src/lib/metricsAlertLogic';

const NOW = new Date('2026-06-20T12:00:00Z').getTime();

/** Mimic a Firestore Timestamp with just the `.toMillis()` the helpers use. */
const ts = (ms: number) => ({ toMillis: () => ms });

describe('telemetryAgeMs', () => {
  it('uses metrics.timestamp when present', () => {
    const data = {
      metrics: { timestamp: ts(NOW - 30_000) },
      lastHeartbeat: ts(NOW - 5 * 60_000),
    };
    assert.equal(telemetryAgeMs(data, NOW), 30_000);
  });

  it('falls back to lastHeartbeat when metrics.timestamp is missing', () => {
    const data = { metrics: {}, lastHeartbeat: ts(NOW - 90_000) };
    assert.equal(telemetryAgeMs(data, NOW), 90_000);
  });

  it('prefers the freshest of the two signals', () => {
    const data = {
      metrics: { timestamp: ts(NOW - 8 * 60_000) },
      lastHeartbeat: ts(NOW - 60_000),
    };
    assert.equal(telemetryAgeMs(data, NOW), 60_000);
  });

  it('returns null when no datable signal is present', () => {
    assert.equal(telemetryAgeMs({ metrics: {} }, NOW), null);
    assert.equal(telemetryAgeMs({}, NOW), null);
    assert.equal(telemetryAgeMs(null, NOW), null);
  });
});

describe('isTelemetryStale', () => {
  it('treats fresh telemetry as live', () => {
    const data = { metrics: { timestamp: ts(NOW - 30_000) } };
    assert.equal(isTelemetryStale(data, NOW), false);
  });

  it('treats a week-old snapshot as stale (the reported bug)', () => {
    const weekAgo = NOW - 7 * 24 * 60 * 60_000;
    const data = { metrics: { timestamp: ts(weekAgo) }, lastHeartbeat: ts(weekAgo) };
    assert.equal(isTelemetryStale(data, NOW), true);
  });

  it('treats missing timestamps as stale (cannot date the value)', () => {
    assert.equal(isTelemetryStale({ metrics: {} }, NOW), true);
  });

  it('is stale just past the window boundary', () => {
    const data = { metrics: { timestamp: ts(NOW - (STALE_METRICS_MS + 1)) } };
    assert.equal(isTelemetryStale(data, NOW), true);
  });

  it('is still live just inside the window boundary', () => {
    const data = { metrics: { timestamp: ts(NOW - (STALE_METRICS_MS - 1)) } };
    assert.equal(isTelemetryStale(data, NOW), false);
  });
});
