/**
 * k6 load test: GET /api/sites/{siteId}/machines.
 *
 * Fleet inventory hot path. The handler reads all machines in a site plus the
 * site's Roost summaries so each machine can report current content.
 *
 * SLO: p99 < 500 ms for a launch fixture site capped at roughly 100 machines.
 *
 * No mutations. Re-runnable without cleanup.
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
  ...optionsFor('machines_list'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/sites/${SITE_ID}/machines`, {
    headers: headers(),
    tags: { endpoint: 'machines_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response.machines is array': (r) => {
      try {
        const b = r.json();
        return Array.isArray(b.machines);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
