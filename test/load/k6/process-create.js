/**
 * k6 load test: POST /api/sites/{siteId}/machines/{machineId}/processes.
 *
 * Each iteration walks auth -> idempotency -> the withProcessLock transaction
 * -> the audit emit. The lock is the slowest hop: it's a Firestore transaction
 * with the duplicate-name check inside it.
 *
 * SLO: p99 < 400 ms. Scenarios: `smoke` (1 VU, 10 s) and `sustained`
 * (ramping to 30 VUs over 5 min). No spike scenario, as in
 * dispatch-machine-command.js.
 *
 * **WRITES TEST DATA** — every iteration appends a process to the machine's
 * config doc. Point `K6_MACHINE_ID` at a dedicated machine and clear it after
 * the run, or prune the `processes` array by hand.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SITE_ID, MACHINE_ID, mutationHeaders, optionsFor } from './lib/config.js';

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
      { duration: '1m', target: 10 },
      { duration: '3m', target: 30 },
      { duration: '1m', target: 30 },
    ],
    tags: { scenario: 'sustained' },
  },
};

export const options = {
  ...optionsFor('process_create'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const url = `${BASE_URL}/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`;

  // Unique per VU+iteration, or the duplicate-name guard inside the lock
  // rejects most requests. Date.now() keeps re-runs unique too.
  const name = `load-${__VU}-${__ITER}-${Date.now()}`;

  const body = JSON.stringify({
    name,
    exe_path: 'C:/load-test/dummy.exe',
  });

  const res = http.post(url, body, {
    headers: mutationHeaders(__VU, __ITER),
    tags: { endpoint: 'process_create' },
  });

  check(res, {
    'status is 201': (r) => r.status === 201,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response.data.processId is string': (r) => {
      try {
        const b = r.json();
        return b && b.ok === true && typeof b.data?.processId === 'string';
      } catch {
        return false;
      }
    },
  });

  sleep(0.25);
}
