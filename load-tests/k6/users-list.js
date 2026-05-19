/**
 * k6 load test: GET /api/users.
 *
 * Platform-wide users collection scan with cursor pagination + optional
 * role/site filters. Superadmin-only (the load test must run with a key
 * holding `user=*:read`). The handler walks `users` ordered by `__name__`
 * with `where(role,...)` / `where(sites,'array-contains',...)` filters when
 * the query string carries them.
 *
 * SLO: p99 < 300 ms (loose because the collection has no inherent partition
 * key — every page is a doc-id-ordered range scan).
 *
 * Scenarios:
 *   `smoke`     — 1 VU, 10 s
 *   `sustained` — ramping 10 → 50 VUs over 5 min
 *   `spike`     — 200 VUs for 30 s
 *
 * No mutations — re-runnable without cleanup.
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
