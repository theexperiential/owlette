/**
 * k6 load test: POST /api/sites/{siteId}/machines/{machineId}/processes
 * (api-sprint wave 2B / process-api).
 *
 * Creates a new process under a machine's config doc. Each iteration:
 *   1. requireMachineAuthAndScope
 *   2. withIdempotency wrapper
 *   3. withProcessLock transaction (process-config-lock CAS)
 *   4. emitMutation audit event
 *
 * The process-config-lock is the slowest hop — it's a Firestore transaction
 * and the duplicate-name check is inside it. Per-VU iterations use a unique
 * `name` (`load-${__VU}-${__ITER}`) so multiple VUs don't collide on the
 * same process record.
 *
 * Idempotency-Key uniqueness: same approach as dispatch-machine-command.js —
 * `mutationHeaders(__VU, __ITER)` embeds VU + iter + timestamp.
 *
 * SLO: p99 < 400 ms.
 *
 * Scenarios (no spike — same reasoning as dispatch-machine-command.js):
 *   `smoke`     — 1 VU, 10 s
 *   `sustained` — ramping 10 → 50 VUs over 5 min
 *
 * **WRITES TEST DATA.** Each iteration appends a process to the machine's
 * config doc. Recommend a periodic sweep: after a load run, prune the
 * `processes` array on the load-test machine doc, or point
 * `K6_MACHINE_ID` at a dedicated load-test machine and clear it post-run.
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

  // Unique per-VU per-iteration name so the duplicate-name guard inside the
  // process-config-lock transaction doesn't reject every other request.
  // The trailing Date.now() makes a re-run of the same VU/iter still unique
  // across separate load-test runs.
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
