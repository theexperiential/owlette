/**
 * Shared k6 config for roost load tests (wave 5.5).
 *
 * BASE_URL and AUTH_TOKEN come from env vars so the same scripts point
 * at dev (dev.owlette.app), prod (owlette.app), or a local emulator
 * without code changes:
 *
 *   K6_BASE_URL=https://dev.owlette.app \
 *   K6_FIREBASE_ID_TOKEN=<token> \
 *   K6_SITE_ID=roost-load-site \
 *   k6 run load-tests/k6/chunks-check.js
 *
 * Target SLOs are expressed here as k6 thresholds — a failing threshold
 * fails the run's exit code, so CI (or a human running locally) gets an
 * immediate pass/fail without reading the histogram.
 */

const env = (key, fallback) =>
  (__ENV && __ENV[key] !== undefined && __ENV[key] !== '' ? __ENV[key] : fallback);

export const BASE_URL = env('K6_BASE_URL', 'http://localhost:3000');
export const SITE_ID = env('K6_SITE_ID', 'roost-load-site');
export const ROOST_ID = env('K6_ROOST_ID', 'roost-load-folder');
export const ID_TOKEN = env('K6_FIREBASE_ID_TOKEN', '');

/**
 * Per-endpoint SLO targets (p99 latency, ms). Numbers chosen so each
 * endpoint is snappy enough that a chained upload (check → upload-urls →
 * N×PUT → finalize-manifest) feels instantaneous to the operator.
 *
 * Rationale:
 *   chunks/check         — 200 ms p99: a fast hash-set diff against R2.
 *   chunks/upload-urls   — 500 ms p99: R2 signed-URL minting is the slow
 *                          part; batches of 1000 tolerated.
 *   roosts/manifests     — 800 ms p99: firestore transaction + chunk-
 *                          presence verify + audit log append.
 *   roosts/rollback      — 400 ms p99: pointer flip in a transaction.
 */
export const SLO_P99_MS = {
  'chunks_check': 200,
  'chunks_upload_urls': 500,
  'chunks_download_urls': 400,
  'roosts_manifests_finalize': 800,
  'roosts_rollback': 400,
};

/**
 * Standard k6 options object with thresholds set per-endpoint. Each load
 * script spreads this + its own scenarios on top.
 */
export function optionsFor(endpointKey) {
  const p99 = SLO_P99_MS[endpointKey];
  if (p99 === undefined) {
    throw new Error(`optionsFor: unknown endpoint key "${endpointKey}"`);
  }
  return {
    thresholds: {
      // the run fails if the p99 for this endpoint exceeds SLO.
      [`http_req_duration{endpoint:${endpointKey}}`]: [`p(99)<${p99}`],
      // base reliability gate: <1% error rate across the run.
      'http_req_failed': ['rate<0.01'],
    },
    // suppress k6's default summary noise for a cleaner CI log;
    // scripts can override.
    summaryTrendStats: ['avg', 'p(95)', 'p(99)', 'max'],
  };
}

/** Headers every roost request carries. */
export function headers() {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/problem+json, application/json',
  };
  if (ID_TOKEN) h.Authorization = `Bearer ${ID_TOKEN}`;
  return h;
}

/**
 * Generate a deterministic but unique 64-char lowercase hex hash.
 * NOT a real sha256 — just a filler of the right shape. Use seed to
 * vary across iterations so each VU sends distinct hashes.
 */
export function fakeHash(seed) {
  const hex = (seed >>> 0).toString(16).padStart(16, '0');
  // pad to 64 chars by repeating; deterministic so retries stay stable.
  return (hex + hex + hex + hex).slice(0, 64);
}
