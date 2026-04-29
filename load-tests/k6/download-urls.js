/**
 * k6 load test: GET /api/chunks/download-urls.
 *
 * Agent and SDK read path for Roost chunks. This mints short-lived signed GET
 * URLs for chunks the caller already knows by hash.
 *
 * SLO: p99 < 400 ms.
 *
 * No data mutations, but the target environment still does real auth and R2
 * signing work.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SITE_ID, fakeHash, headers, optionsFor } from './lib/config.js';

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
    executor: 'constant-vus',
    vus: 50,
    duration: '30s',
    tags: { scenario: 'burst' },
  },
};

export const options = {
  ...optionsFor('chunks_download_urls'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const hashes = [];
  for (let i = 0; i < 10; i++) {
    hashes.push(`hash=${encodeURIComponent(fakeHash(__VU * 10000 + __ITER * 10 + i))}`);
  }

  const url = `${BASE_URL}/api/chunks/download-urls?siteId=${encodeURIComponent(SITE_ID)}&${hashes.join('&')}`;
  const res = http.get(url, {
    headers: headers(),
    tags: { endpoint: 'chunks_download_urls' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response has urls map': (r) => {
      try {
        const b = r.json();
        return b.urls && typeof b.urls === 'object';
      } catch {
        return false;
      }
    },
  });

  sleep(0.25);
}
