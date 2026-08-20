/**
 * k6 load test: GET /api/users — platform-wide collection scan with cursor
 * pagination and optional role/site filters. Needs a key holding `user=*:read`.
 *
 * SLO p99 < 300 ms, loose because the collection has no partition key: every
 * page is a doc-id-ordered range scan.
 *
 * Scenarios: `smoke` (1 VU, 10s), `sustained` (10→50 VUs over 5m), `spike`
 * (200 VUs, 30s). No mutations — re-runnable without cleanup.
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
  ...optionsFor('users_list'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/users?page_size=25`, {
    headers: headers(),
    tags: { endpoint: 'users_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response.users is array': (r) => {
      try {
        const b = r.json();
        return Array.isArray(b.users);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
