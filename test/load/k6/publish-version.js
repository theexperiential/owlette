/**
 * k6 load test: POST /api/roosts/{roostId}/versions.
 *
 * Transaction-heavy tail of the Roost upload flow. The route validates a
 * version body, verifies chunk presence, writes the version body to R2, and
 * flips currentVersionId inside a Firestore transaction.
 *
 * SLO: p99 < 800 ms.
 *
 * Required fixture:
 *   K6_VERSION_CHUNK_HASHES=comma,separated,64char,lowercase,hex,hashes
 *
 * Scenarios:
 *   `smoke`     - single publish loop.
 *   `sustained` - light concurrent publish pressure.
 *   `race`      - 20 concurrent publishes against one expected head; exactly
 *                 one should return 201 and the rest should return 412.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, MACHINE_ID, ROOST_ID, SITE_ID, mutationHeaders, optionsFor } from './lib/config.js';

const SCENARIO = __ENV.SCENARIO || 'smoke';
const raceWinners = new Counter('publish_version_race_winners');
const raceLosers = new Counter('publish_version_race_losers');

const ALL_SCENARIOS = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '10s',
    tags: { scenario: 'smoke' },
  },
  race: {
    executor: 'per-vu-iterations',
    vus: 20,
    iterations: 1,
    maxDuration: '30s',
    tags: { scenario: 'race' },
  },
  sustained: {
    executor: 'constant-vus',
    vus: 5,
    duration: '2m',
    tags: { scenario: 'sustained' },
  },
};

export const options = {
  ...optionsFor('roosts_versions_publish'),
  scenarios: { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
  thresholds: {
    ...optionsFor('roosts_versions_publish').thresholds,
    ...(SCENARIO === 'race'
      ? {
          'http_req_failed': ['rate<0.99'],
          'publish_version_race_winners': ['count>0', 'count<2'],
          'publish_version_race_losers': ['count>18', 'count<20'],
        }
      : {}),
  },
};

function fixtureChunkHashes() {
  const raw = __ENV.K6_VERSION_CHUNK_HASHES || '';
  const hashes = raw.split(',').map((h) => h.trim()).filter(Boolean);
  if (hashes.length === 0) {
    throw new Error('K6_VERSION_CHUNK_HASHES is required for publish-version.js');
  }
  return hashes;
}

function buildVersion(vu, iter) {
  const chunks = fixtureChunkHashes().map((hash) => ({ hash, size: 4 * 1024 * 1024 }));
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {
      name: `k6-${vu}-${iter}`,
      createdAt: new Date().toISOString(),
      createdBy: `k6-vu-${vu}`,
      siteId: SITE_ID,
    },
    files: [
      {
        path: `test/file-${vu}-${iter}.bin`,
        size: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
        chunks,
      },
    ],
  };
}

export default function () {
  const expectedCurrentVersionId =
    SCENARIO === 'race' ? (__ENV.K6_EXPECTED_CURRENT_VERSION_ID || '') : undefined;
  if (SCENARIO === 'race' && !expectedCurrentVersionId) {
    throw new Error('K6_EXPECTED_CURRENT_VERSION_ID is required for the race scenario');
  }

  const body = JSON.stringify({
    siteId: SITE_ID,
    version: buildVersion(__VU, __ITER),
    expectedCurrentVersionId,
    name: `k6-${__VU}-${__ITER}`,
    targets: MACHINE_ID ? [MACHINE_ID] : [],
    description: `k6 publish ${__VU}/${__ITER}`,
  });

  const res = http.post(`${BASE_URL}/api/roosts/${ROOST_ID}/versions`, body, {
    headers: mutationHeaders(__VU, __ITER),
    tags: { endpoint: 'roosts_versions_publish' },
  });

  if (SCENARIO === 'race') {
    if (res.status === 201) raceWinners.add(1);
    if (res.status === 412) raceLosers.add(1);
    check(res, {
      'race: status is 201 (winner) or 412 (loser)': (r) =>
        r.status === 201 || r.status === 412,
    });
  } else {
    check(res, {
      'status is 201': (r) => r.status === 201,
      'body has versionId': (r) => {
        try {
          return typeof r.json('versionId') === 'string';
        } catch {
          return false;
        }
      },
    });
  }
}

export function handleSummary() {
  if (SCENARIO !== 'race') return {};
  return {
    stdout: 'race scenario complete. Thresholds require exactly one 201 winner and nineteen 412 losers.\n',
  };
}
