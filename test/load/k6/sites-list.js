/**
 * k6 load test: GET /api/sites.
 *
 * Initial API bootstrap path for CLI/SDK clients. Scoped API keys should only
 * see sites covered by their explicit site scopes; session/superadmin callers
 * can see a broader account view.
 *
 * SLO: p99 < 300 ms.
 *
 * No mutations. Re-runnable without cleanup.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, headers, optionsFor } from './lib/config.js';

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
  ...optionsFor('sites_list'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/sites`, {
    headers: headers(),
    tags: { endpoint: 'sites_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response.sites is array': (r) => {
      try {
        const b = r.json();
        return Array.isArray(b.sites);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
