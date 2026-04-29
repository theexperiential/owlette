/**
 * k6 load test: POST /api/chunks/upload-urls.
 *
 * Called after /api/chunks/check to mint signed PUT URLs for every
 * chunk the server doesn't already have. R2 signed-URL issuance is
 * the slow part — each URL requires an HMAC + short-lived cert lookup
 * server-side.
 *
 * SLO: p99 < 500 ms. Batches up to 1000 hashes per request.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SITE_ID, fakeHash, mutationHeaders, optionsFor } from './lib/config.js';

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
    startVUs: 5,
    stages: [
      { duration: '1m', target: 5 },
      { duration: '3m', target: 20 },
      { duration: '1m', target: 20 },
    ],
    tags: { scenario: 'sustained' },
  },
  burst: {
    // realistic: a customer hits upload-urls for a 10 GB folder = ~2500
    // chunks = 3 rounds of 1000 batches. 50 concurrent customers for 30s
    // simulates a mid-morning spike.
    executor: 'constant-vus',
    vus: 50,
    duration: '30s',
    tags: { scenario: 'burst' },
  },
};

export const options = {
  ...optionsFor('chunks_upload_urls'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  // 50 hashes per batch — middle of the allowed 1..1000 range; real
  // clients vary but this is representative for mid-size folders.
  const hashes = [];
  for (let i = 0; i < 50; i++) {
    hashes.push(fakeHash(__VU * 10000 + __ITER * 50 + i));
  }
  const body = JSON.stringify({ siteId: SITE_ID, hashes });
  const res = http.post(`${BASE_URL}/api/chunks/upload-urls`, body, {
    headers: mutationHeaders(__VU, __ITER),
    tags: { endpoint: 'chunks_upload_urls' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has urls map': (r) => {
      try {
        const b = r.json();
        return b.urls && typeof b.urls === 'object';
      } catch {
        return false;
      }
    },
  });

  // simulate the client handoff to the real PUT uploads (which this
  // test deliberately doesn't do — the R2 upload path is tested separately).
  sleep(0.25);
}
