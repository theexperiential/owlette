/**
 * Metric-threshold alert freshness gating.
 *
 * Regression guarded: an offline machine's frozen metrics were re-evaluated on
 * every unrelated write that re-triggered onMetricsWrite, re-firing "disk
 * 87.2% > 85" hourly for a machine offline for a week.
 *
 * Field-shape gotcha: the agent writes freshness via the dotted key
 * 'metrics.timestamp', and its REST client backtick-escapes dotted
 * SERVER_TIMESTAMP keys, so it lands as a LITERAL top-level field of that
 * name, NOT nested under the metrics map. That literal is the primary shape
 * here; the nested and lastHeartbeat fallbacks are also covered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_METRICS_MS,
  telemetryAgeMs,
  isTelemetryStale,
  metricsWriteDisposition,
} from '../src/lib/metricsAlertLogic';

const NOW = new Date('2026-06-20T12:00:00Z').getTime();
const WEEK_AGO = NOW - 7 * 24 * 60 * 60_000;

/** Mimic a Firestore Timestamp with just the `.toMillis()` the helpers use. */
const ts = (ms: number) => ({ toMillis: () => ms });

describe('telemetryAgeMs', () => {
  it('reads the LITERAL "metrics.timestamp" field (production storage), ignoring a fresher lastHeartbeat', () => {
    const data = {
      'metrics.timestamp': ts(NOW - 30_000),
      lastHeartbeat: ts(NOW - 5 * 60_000),
    };
    assert.equal(telemetryAgeMs(data, NOW), 30_000);
  });

  it('also accepts a genuinely-nested metrics.timestamp (future-proof if agent storage is corrected)', () => {
    const data = { metrics: { timestamp: ts(NOW - 30_000) } };
    assert.equal(telemetryAgeMs(data, NOW), 30_000);
  });

  it('prefers the literal field over a nested one when both exist', () => {
    const data = {
      'metrics.timestamp': ts(NOW - 30_000),
      metrics: { timestamp: ts(NOW - 9 * 60_000) },
    };
    assert.equal(telemetryAgeMs(data, NOW), 30_000);
  });

  it('falls back to lastHeartbeat only when no metrics timestamp exists (legacy docs)', () => {
    const data = { metrics: { disks: {} }, lastHeartbeat: ts(NOW - 90_000) };
    assert.equal(telemetryAgeMs(data, NOW), 90_000);
  });

  it('dates by the metrics timestamp even when lastHeartbeat is fresher (offline-write guard)', () => {
    // _update_presence(False) re-stamps lastHeartbeat to ~now while leaving
    // the metrics frozen — must NOT read as fresh telemetry.
    const data = {
      'metrics.timestamp': ts(NOW - 8 * 60_000),
      lastHeartbeat: ts(NOW - 60_000),
    };
    assert.equal(telemetryAgeMs(data, NOW), 8 * 60_000);
  });

  it('returns null when no datable signal is present', () => {
    assert.equal(telemetryAgeMs({ metrics: {} }, NOW), null);
    assert.equal(telemetryAgeMs({}, NOW), null);
    assert.equal(telemetryAgeMs(null, NOW), null);
  });

  it('treats a RAW NUMBER timestamp as undatable (Timestamp-only contract)', () => {
    // A plain epoch number is intentionally NOT datable — fails closed to
    // stale rather than being misread as ms-vs-seconds.
    assert.equal(telemetryAgeMs({ 'metrics.timestamp': NOW - 30_000 }, NOW), null);
    assert.equal(telemetryAgeMs({ lastHeartbeat: NOW - 30_000 }, NOW), null);
    assert.equal(isTelemetryStale({ 'metrics.timestamp': NOW - 30_000 }, NOW), true);
  });
});

describe('metricsWriteDisposition (the onMetricsWrite gate ordering)', () => {
  it('processes a fresh, metrics-bearing write', () => {
    const data = { metrics: { disks: {} }, 'metrics.timestamp': ts(NOW - 30_000) };
    assert.equal(metricsWriteDisposition(data, NOW), 'process');
  });

  it('skips a write with no metrics map', () => {
    assert.equal(metricsWriteDisposition({ lastHeartbeat: ts(NOW) }, NOW), 'skip-no-metrics');
    assert.equal(metricsWriteDisposition({}, NOW), 'skip-no-metrics');
    assert.equal(metricsWriteDisposition(null, NOW), 'skip-no-metrics');
  });

  it('checks metrics-presence BEFORE freshness (no-metrics wins over a stale timestamp)', () => {
    // skip-no-metrics must win over skip-stale; the ordering must not regress.
    assert.equal(
      metricsWriteDisposition({ 'metrics.timestamp': ts(WEEK_AGO), lastHeartbeat: ts(WEEK_AGO) }, NOW),
      'skip-no-metrics',
    );
  });

  it('skips a stale metrics-bearing write (offline machine frozen snapshot)', () => {
    const data = {
      metrics: { disks: {} },
      'metrics.timestamp': ts(WEEK_AGO),
      lastHeartbeat: ts(WEEK_AGO),
    };
    assert.equal(metricsWriteDisposition(data, NOW), 'skip-stale');
  });

  it('skips a just-gone-offline write — fresh lastHeartbeat but frozen metrics (the real prod shape)', () => {
    // lastHeartbeat re-stamped to ~now, metrics frozen. Must skip.
    const data = {
      metrics: { disks: {} },
      'metrics.timestamp': ts(NOW - 30 * 60_000),
      lastHeartbeat: ts(NOW),
    };
    assert.equal(metricsWriteDisposition(data, NOW), 'skip-stale');
  });

  it('skips a metrics-bearing write with no datable timestamp', () => {
    assert.equal(metricsWriteDisposition({ metrics: { disks: {} } }, NOW), 'skip-stale');
  });
});

describe('isTelemetryStale', () => {
  it('treats fresh telemetry as live', () => {
    assert.equal(isTelemetryStale({ 'metrics.timestamp': ts(NOW - 30_000) }, NOW), false);
  });

  it('treats a week-old snapshot as stale (the reported bug)', () => {
    const data = { 'metrics.timestamp': ts(WEEK_AGO), lastHeartbeat: ts(WEEK_AGO) };
    assert.equal(isTelemetryStale(data, NOW), true);
  });

  it('treats missing timestamps as stale (cannot date the value)', () => {
    assert.equal(isTelemetryStale({ metrics: {} }, NOW), true);
  });

  it('is stale just past the window boundary', () => {
    assert.equal(isTelemetryStale({ 'metrics.timestamp': ts(NOW - (STALE_METRICS_MS + 1)) }, NOW), true);
  });

  it('is still live just inside the window boundary', () => {
    assert.equal(isTelemetryStale({ 'metrics.timestamp': ts(NOW - (STALE_METRICS_MS - 1)) }, NOW), false);
  });
});
