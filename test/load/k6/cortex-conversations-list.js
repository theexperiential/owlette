/**
 * k6 load test: GET /api/cortex/conversations?siteId=…
 *
 * The handler resolves the caller's effective site set (membership + ownership
 * ∩ api-key scope) then runs a composite `chat_conversations` query with cursor
 * pagination — Firestore-heavy on cold caches, so the SLO (p99 < 300 ms) is a
 * touch looser than the other lists to absorb multi-site fan-out.
 *
 * Scenarios: `smoke` (1 VU/10 s), `sustained` (10→50 VUs/5 min), `spike`
 * (200 VUs/30 s). No mutations — re-runnable without cleanup.
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
  // siteId is only a hint; the route resolves the readable set from key scopes.
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
