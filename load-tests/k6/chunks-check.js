/**
 * k6 load test: POST /api/chunks/check (wave 5.5).
 *
 * The hot path when a browser client re-drops a previously-uploaded
 * folder: for every chunk in the new manifest, does the server already
 * have that byte-sequence? Small-but-frequent calls — request body is
 * a list of 1..1000 sha-256 hashes, response is the subset missing.
 *
 * SLO: p99 < 200 ms. See lib/config.js for rationale.
 *
 * Scenarios:
 *   `smoke`   — 1 VU, 10 s: regression floor, run every CI build.
 *   `sustained` — ramping 10 → 50 VUs over 5 min: "are we fine at
 *                  30 ops/sec per VU sustained?" check.
 *   `spike`   — 200 VUs for 30 s: what happens when a customer re-drops
 *               a 500 GB folder in 50k-chunk batches?
 *
 * Run a single scenario with:
 *   K6_BASE_URL=https://dev.owlette.app k6 run --env SCENARIO=smoke chunks-check.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, ROOST_ID as _ROOST_ID, SITE_ID, fakeHash, headers, optionsFor } from './lib/config.js';

const SCENARIO = __ENV.SCENARIO || 'smoke';

const ALL_SCENARIOS = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '10s',
    tags: { scenario: 'smoke' },
  },
  sustained: {
    executor: 'ramping-vus',
    startVUs: 10,
    stages: [
      { duration: '1m', target: 10 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 50 },
    ],
    tags: { scenario: 'sustained' },
  },
  spike: {
    executor: 'constant-vus',
    vus: 200,
    duration: '30s',
    tags: { scenario: 'spike' },
  },
};

export const options = {
  ...optionsFor('chunks_check'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  // build a batch of 100 hashes per request. unique per VU+iteration so
  // the server can't just return a cached identical response.
  const hashes = [];
  for (let i = 0; i < 100; i++) {
    hashes.push(fakeHash(__VU * 1000 + __ITER * 100 + i));
  }

  const body = JSON.stringify({ siteId: SITE_ID, hashes });
  const res = http.post(`${BASE_URL}/api/chunks/check`, body, {
    headers: headers(),
    tags: { endpoint: 'chunks_check' },
  });

  check(res, {
    'status is 200 or 501 (stub)': (r) => r.status === 200 || r.status === 501,
    'body is JSON': (r) => {
      const ct = r.headers['Content-Type'] || '';
      return ct.includes('json');
    },
    'response has `missing` field OR is a problem+json': (r) => {
      if (r.status === 501) return true; // stub is fine while wiring lands
      try {
        const b = r.json();
        return Array.isArray(b.missing);
      } catch {
        return false;
      }
    },
  });

  // think time to mimic real client bursts between manifest-build passes.
  sleep(0.1);
}
