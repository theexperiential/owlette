/**
 * k6 load test: GET /api/sites/{siteId}/machines/{machineId}/processes
 * (api-sprint wave 2B).
 *
 * The fleet-management UI + every external monitoring integration polls this
 * endpoint per machine. Returns the merged config + live-status process list
 * — one Firestore doc read for the config + one for the machine status.
 *
 * SLO: p99 < 250 ms.
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
import { BASE_URL, SITE_ID, MACHINE_ID, headers, optionsFor } from './lib/config.js';

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
  ...optionsFor('process_list'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const url = `${BASE_URL}/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`;
  const res = http.get(url, {
    headers: headers(),
    tags: { endpoint: 'process_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response.data.processes is array': (r) => {
      try {
        const b = r.json();
        return b && b.ok === true && Array.isArray(b.data?.processes);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
