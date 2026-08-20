/**
 * k6: GET /api/sites/{siteId}/deployments — a 25-doc page plus `page_token`
 * pagination, the endpoint behind the dashboard list and every paginating
 * CLI/SDK. SLO p99 < 250 ms (rationale in lib/config.js).
 *
 * Scenarios: `smoke` (1 VU/10s, CI regression floor), `sustained` (ramp to 50
 * over 5 min, typical dashboard load), `spike` (200 VUs/30s, a CI fleet polling
 * at once). Select with `--env SCENARIO=smoke`.
 *
 * No mutations — safe to re-run without cleanup.
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

  // think-time so a VU doesn't pin the client CPU
  sleep(0.1);
}
