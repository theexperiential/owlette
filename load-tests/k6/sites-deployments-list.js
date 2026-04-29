/**
 * k6 load test: GET /api/sites/{siteId}/deployments.
 *
 * The dashboard's deployment list view + every CLI/SDK that paginates
 * deployments hits this endpoint. Reads a 25-doc page from Firestore and
 * paginates via `page_token`. Read-mostly: cursor reads + cheap doc fetches.
 *
 * SLO: p99 < 250 ms. See lib/config.js for rationale.
 *
 * Scenarios:
 *   `smoke`     — 1 VU, 10 s: regression floor, run every CI build.
 *   `sustained` — ramping 10 → 50 VUs over 5 min: typical dashboard load.
 *   `spike`     — 200 VUs for 30 s: burst when a fleet of CIs all poll
 *                 deployment status concurrently.
 *
 * Run a single scenario with:
 *   K6_BASE_URL=https://dev.owlette.app \
 *     K6_API_KEY=$(<api-key.txt) \
 *     K6_SITE_ID=load-test-site \
 *     k6 run --env SCENARIO=smoke sites-deployments-list.js
 *
 * No mutations — this script is safe to re-run without cleanup.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SITE_ID, headers, optionsFor } from './lib/config.js';

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
  ...optionsFor('sites_deployments_list'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/sites/${SITE_ID}/deployments?page_size=25`, {
    headers: headers(),
    tags: { endpoint: 'sites_deployments_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response has `items` array': (r) => {
      try {
        const b = r.json();
        return Array.isArray(b.items);
      } catch {
        return false;
      }
    },
  });

  // Light think-time so we don't pin a single VU at 100% CPU on the client.
  sleep(0.1);
}
