/**
 * k6 load test: POST /api/chunks/check — the hot path when a client re-drops a
 * known folder. Body is 1..1000 sha-256 hashes; response is the missing subset.
 * SLO p99 < 200 ms (rationale in lib/config.js).
 *
 * Scenarios: `smoke` (CI regression floor), `sustained` (10→50 VUs / 5 min),
 * `spike` (200 VUs / 30 s — a 500 GB re-drop in 50k-chunk batches).
 *
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
  // Unique per VU+iteration so the server can't serve a cached response.
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
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => {
      const ct = r.headers['Content-Type'] || '';
      return ct.includes('json');
    },
    'response has `missing` field': (r) => {
      try {
        const b = r.json();
        return Array.isArray(b.missing);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1); // think time between manifest-build passes

}
