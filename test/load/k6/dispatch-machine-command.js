/**
 * k6: POST /api/sites/{siteId}/machines/{machineId}/commands — the mutation hot
 * path (auth+scope, idempotency wrapper, online check, pending-doc write, audit
 * emit). SLO p99 < 400 ms. Scenarios: `smoke` (1 VU/10s) and `sustained` (ramp);
 * no spike profile — mutations bottleneck on audit emit + write queue.
 *
 * `mutationHeaders(__VU, __ITER)` must stay unique per call: a shared
 * Idempotency-Key replays the cached 202 and turns this into a cache benchmark.
 *
 * WRITES TEST DATA — each iteration adds a `commands/pending` field. Point
 * K6_MACHINE_ID at a load-test-only machine, or sweep afterwards with
 *   gcloud firestore delete --recursive sites/<SITE_ID>/machines/<MACHINE_ID>/commands
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
  ...optionsFor('machine_command_dispatch'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  const url = `${BASE_URL}/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`;
  const body = JSON.stringify({
    type: 'reboot_machine',
    params: { delay_seconds: 30 },
    timeout_seconds: 60,
  });

  const res = http.post(url, body, {
    headers: mutationHeaders(__VU, __ITER),
    tags: { endpoint: 'machine_command_dispatch' },
  });

  check(res, {
    'status is 202': (r) => r.status === 202,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response shape is sane': (r) => {
      try {
        const b = r.json();
        return b && b.ok === true && typeof b.data?.commandId === 'string';
      } catch {
        return false;
      }
    },
  });

  // stagger: every VU writes the same `pending` field, so back-to-back iterations contend
  sleep(0.25);
}
