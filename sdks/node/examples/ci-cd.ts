/**
 * ci/cd: publish a new roost version on every git tag.
 *
 * Mirrors docs/api/examples/ci-cd-github-actions.md but replaces ~150 lines
 * of curl + jq with a single `roost.roosts.push()` call. Drop it in a GitHub
 * Actions step and run `node --loader tsx ci-cd.ts` (or transpile to JS).
 *
 * Required env vars:
 *   ROOST_TOKEN     — api key with roost:<id>:write,deploy scope
 *   ROOST_SITE_ID   — site hosting the roost
 *   ROOST_ID        — target roost id
 *   BUILD_DIR       — directory to publish (defaults to ./build)
 *
 * Exits 0 on success, 1 on recoverable failure, 2 on scope/quota errors.
 */

import { Roost, RoostApiError } from '../src/index.js';

const {
  ROOST_TOKEN, ROOST_SITE_ID, ROOST_ID,
  BUILD_DIR = './build',
  ROOST_BASE = 'https://owlette.app',
  GITHUB_REF_NAME: VERSION = 'dev',
} = process.env;

for (const k of ['ROOST_TOKEN', 'ROOST_SITE_ID', 'ROOST_ID']) {
  if (!process.env[k]) {
    console.error(`fatal: missing env var ${k}`);
    process.exit(1);
  }
}

const roost = new Roost({ token: ROOST_TOKEN!, apiUrl: ROOST_BASE });

try {
  console.log(`[ci-cd] publishing ${BUILD_DIR} → ${ROOST_ID} (version ${VERSION})`);
  const result = await roost.roosts.push(BUILD_DIR, ROOST_ID!, {
    siteId: ROOST_SITE_ID!,
    onProgress: (evt) => {
      if (evt.phase === 'upload') console.log(`  upload ${evt.uploaded}/${evt.total}`);
      if (evt.phase === 'publish') console.log(`  publish attempt ${evt.attempt}`);
    },
  });

  console.log('[ci-cd] published manifest', result.manifestId);
  console.log('[ci-cd] stats:', JSON.stringify(result.stats, null, 2));

  // trigger fleet deploy immediately — skip for staged rollouts
  const deploy = await roost.roosts.deploy(ROOST_ID!, { siteId: ROOST_SITE_ID! });
  console.log(`[ci-cd] rollout ${deploy.rolloutId} — ${deploy.fleet.length} machines queued`);

  process.exit(0);
} catch (err) {
  if (err instanceof RoostApiError) {
    console.error(`[ci-cd] roost api error ${err.status} ${err.code}: ${err.problem.detail}`);
    console.error(`  request_id: ${err.requestId}`);
    if (err.code === 'scope_insufficient' || err.code === 'quota_exceeded') process.exit(2);
  } else {
    console.error('[ci-cd] unexpected error:', err);
  }
  process.exit(1);
}
