/**
 * k6 load test: GET /api/cortex/conversations?siteId=...
 *
 * Lists chat conversations the caller can read. The handler:
 *   1. resolves the caller's effective site set (membership + ownership +
 *      api-key scope intersection)
 *   2. runs a Firestore composite query on `chat_conversations` filtered to
 *      that set with cursor pagination
 *
 * Firestore-heavy on cold caches — the SLO is a touch looser than the other
 * lists to absorb a fan-out across multi-site users.
 *
 * SLO: p99 < 300 ms.
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
  ...optionsFor('cortex_conversations_list'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
};

export default function () {
  // siteId is also used as a hint for the conversation filter; the route
  // resolves the actual readable set from the api-key scopes.
  const url = `${BASE_URL}/api/cortex/conversations?page_size=25&siteId=${encodeURIComponent(SITE_ID)}`;
  const res = http.get(url, {
    headers: headers(),
    tags: { endpoint: 'cortex_conversations_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is JSON': (r) => (r.headers['Content-Type'] || '').includes('json'),
    'response.data.conversations is array': (r) => {
      try {
        const b = r.json();
        return b && b.ok === true && Array.isArray(b.data?.conversations);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
