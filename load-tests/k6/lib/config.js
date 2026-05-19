/**
 * Shared k6 config for public API launch load tests.
 *
 * BASE_URL and AUTH_TOKEN come from env vars so the same scripts point at dev,
 * prod, or a local server without code changes:
 *
 *   K6_BASE_URL=https://dev.owlette.app
 *   K6_API_KEY=owk_test_...
 *   K6_SITE_ID=owlette-load-site
 *   k6 run load-tests/k6/chunks-check.js
 *
 * Target SLOs are expressed as k6 thresholds. A failing threshold fails the
 * run's exit code, so CI and humans get a direct pass/fail signal.
 */

const env = (key, fallback) =>
  (__ENV && __ENV[key] !== undefined && __ENV[key] !== '' ? __ENV[key] : fallback);

export const BASE_URL = env('K6_BASE_URL', 'http://localhost:3000');
export const SITE_ID = env('K6_SITE_ID', 'owlette-load-site');
export const ROOST_ID = env('K6_ROOST_ID', 'roost-load-folder');
export const MACHINE_ID = env('K6_MACHINE_ID', 'owlette-load-machine');
export const ID_TOKEN = env('K6_FIREBASE_ID_TOKEN', '');

/**
 * Optional `owk_*` API key. When set, it takes precedence over ID_TOKEN because
 * public launch load tests should mirror SDK/CLI traffic.
 */
export const API_KEY = env('K6_API_KEY', '');

/**
 * Per-endpoint SLO targets (p99 latency, ms). Numbers are chosen so common
 * CLI/SDK workflows can chain inventory reads, signed URL issuance, direct
 * uploads, and version publication without visible stalls.
 */
export const SLO_P99_MS = {
  'chunks_check': 200,
  'chunks_upload_urls': 500,
  'chunks_download_urls': 400,
  'roosts_versions_publish': 800,
  'sites_list': 300,
  'machines_list': 500,
  'sites_deployments_list': 250,
  'process_list': 250,
  'cortex_conversations_list': 300,
  'users_list': 300,
  'machine_command_dispatch': 400,
  'process_create': 400,
};

/**
 * Standard k6 options object with thresholds set per-endpoint. Each load
 * script spreads this and its own scenarios on top.
 */
export function optionsFor(endpointKey) {
  const p99 = SLO_P99_MS[endpointKey];
  if (p99 === undefined) {
    throw new Error(`optionsFor: unknown endpoint key "${endpointKey}"`);
  }
  return {
    thresholds: {
      [`http_req_duration{endpoint:${endpointKey}}`]: [`p(99)<${p99}`],
      'http_req_failed': ['rate<0.01'],
    },
    summaryTrendStats: ['avg', 'p(95)', 'p(99)', 'max'],
  };
}

/** Headers every public API request carries. */
export function headers() {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/problem+json, application/json',
  };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  else if (ID_TOKEN) h.Authorization = `Bearer ${ID_TOKEN}`;
  return h;
}

/**
 * Headers plus a per-VU per-iteration unique `Idempotency-Key`. Use on POST /
 * PUT load scripts so the idempotency cache does not make every VU share one
 * cached response.
 */
export function mutationHeaders(vu, iter) {
  return {
    ...headers(),
    'Idempotency-Key': `k6-${BASE_URL.replace(/[^a-z0-9]/gi, '')}-${vu}-${iter}-${Date.now()}`,
  };
}

/**
 * Generate a deterministic but unique 64-char lowercase hex hash. This is not
 * a real SHA-256 digest; it is only filler with the right shape.
 */
export function fakeHash(seed) {
  const hex = (seed >>> 0).toString(16).padStart(16, '0');
  return (hex + hex + hex + hex).slice(0, 64);
}
