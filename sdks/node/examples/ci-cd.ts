/**
 * ci/cd: publish a new roost version on every git tag.
 *
 * Mirrors docs/api/examples/ci-cd-github-actions.md but replaces curl + jq
 * with a single `owlette.roosts.push()` call.
 *
 * Required env vars:
 *   OWLETTE_TOKEN   api key with roost:<id>:write,deploy scope
 *   ROOST_SITE_ID   site hosting the roost
 *   ROOST_ID        target roost id
 *   BUILD_DIR       directory to publish (defaults to ./build)
 */

import { Owlette, OwletteApiError } from '@owlette/sdk';

const {
  OWLETTE_TOKEN, ROOST_SITE_ID, ROOST_ID,
  BUILD_DIR = './build',
  OWLETTE_API_URL = 'https://owlette.app',
  GITHUB_REF_NAME: VERSION = 'dev',
} = process.env;

async function main(): Promise<number> {
  for (const k of ['OWLETTE_TOKEN', 'ROOST_SITE_ID', 'ROOST_ID']) {
    if (!process.env[k]) {
      console.error(`fatal: missing env var ${k}`);
      return 1;
    }
  }

  const owlette = new Owlette({ token: OWLETTE_TOKEN!, apiUrl: OWLETTE_API_URL });

  try {
    console.log(`[ci-cd] publishing ${BUILD_DIR} -> ${ROOST_ID} (version ${VERSION})`);
    const result = await owlette.roosts.push(BUILD_DIR, ROOST_ID!, {
      siteId: ROOST_SITE_ID!,
      onProgress: (evt) => {
        if (evt.phase === 'upload') console.log(`  upload ${evt.uploaded}/${evt.total}`);
        if (evt.phase === 'publish') console.log(`  publish attempt ${evt.attempt}`);
      },
    });

    console.log('[ci-cd] published version', result.versionId, `#${result.versionNumber}`);
    console.log('[ci-cd] stats:', JSON.stringify(result.stats, null, 2));

    const deploy = await owlette.roosts.deploy(ROOST_ID!, { siteId: ROOST_SITE_ID! });
    console.log(`[ci-cd] rollout ${deploy.rolloutId} - ${deploy.fleet.length} machines queued`);

    return 0;
  } catch (err) {
    if (err instanceof OwletteApiError) {
      console.error(`[ci-cd] roost api error ${err.status} ${err.code}: ${err.problem.detail}`);
      console.error(`  request_id: ${err.requestId}`);
      if (err.code === 'scope_insufficient' || err.code === 'quota_exceeded') return 2;
    } else {
      console.error('[ci-cd] unexpected error:', err);
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
