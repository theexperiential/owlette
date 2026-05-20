/**
 * k6 load test: POST /api/sites/{siteId}/machines/{machineId}/commands
 * public API launch load suite.
 *
 * Mutation hot path: queues a `reboot_machine` command. Each iteration:
 *   1. requireMachineAuthAndScope (api-key resolution + scope check + audit)
 *   2. withIdempotency wrapper (24h replay window)
 *   3. machine.online check (single doc read)
 *   4. command write to `commands/pending` doc field
 *   5. emitMutation audit event
 *
 * Idempotency-Key uniqueness:
 *   Each call uses `mutationHeaders(__VU, __ITER)` from lib/config.js, which
 *   embeds VU + iteration index + a Date.now() timestamp into the header.
 *   Without this, every VU+iteration would replay the same cached 202 and
 *   the load test would degenerate into a cache-hit microbenchmark.
 *
 * SLO: p99 < 400 ms.
 *
 * Scenarios (no spike — mutations stress the audit-log emit + Firestore write
 *           queue more than reads, so we cap at the sustained-ramp profile):
 *   `smoke`     — 1 VU, 10 s
 *   `sustained` — ramping 10 → 50 VUs over 5 min
 *
 * **WRITES TEST DATA.** Each iteration creates a `commands/pending` field
 * keyed by a fresh commandId. Recommend a periodic sweep: after a load run,
 * delete the pending command doc:
 *   gcloud firestore delete --recursive sites/<SITE_ID>/machines/<MACHINE_ID>/commands
 * Or just point K6_MACHINE_ID at a load-test-only machine and reset its doc.
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

  // Stagger between mutations so we don't pin the same machine doc on every
  // VU iteration (Firestore write contention on the `pending` field).
  sleep(0.25);
}
