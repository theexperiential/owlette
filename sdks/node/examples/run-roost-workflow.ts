/**
 * Minimal public-api workflow:
 *   1. authenticate the token with /api/whoami
 *   2. inspect the target site and roost
 *   3. publish BUILD_DIR as a new roost version
 *
 * Required env vars:
 *   OWLETTE_TOKEN or ROOST_TOKEN
 *   OWLETTE_SITE_ID or ROOST_SITE_ID
 *   OWLETTE_ROOST_ID or ROOST_ID
 *   BUILD_DIR defaults to ./dist
 *
 * Optional:
 *   OWLETTE_API_URL or ROOST_BASE defaults to https://owlette.app
 *   OWLETTE_DEPLOY=1 queues a deploy after the publish
 */

import { Roost, RoostApiError } from '@owlette/sdk';

const token = process.env.OWLETTE_TOKEN ?? process.env.ROOST_TOKEN;
const apiUrl = process.env.OWLETTE_API_URL ?? process.env.ROOST_BASE ?? 'https://owlette.app';
const siteId = process.env.OWLETTE_SITE_ID ?? process.env.ROOST_SITE_ID;
const roostId = process.env.OWLETTE_ROOST_ID ?? process.env.ROOST_ID;
const buildDir = process.env.BUILD_DIR ?? './dist';
const shouldDeploy = process.env.OWLETTE_DEPLOY === '1';

for (const [name, value] of [
  ['OWLETTE_TOKEN or ROOST_TOKEN', token],
  ['OWLETTE_SITE_ID or ROOST_SITE_ID', siteId],
  ['OWLETTE_ROOST_ID or ROOST_ID', roostId],
]) {
  if (!value) {
    console.error(`missing env var: ${name}`);
    process.exit(1);
  }
}

const roost = new Roost({ token: token!, apiUrl });

try {
  const [identity, version] = await Promise.all([
    roost.account.whoami(),
    roost.account.version(),
  ]);
  console.log('api', version.current, 'user', identity.email ?? identity.userId);
  console.log('key', identity.key?.keyPrefix ?? 'session', 'primary site', identity.primarySiteId);

  const [site, currentRoost] = await Promise.all([
    roost.sites.get(siteId!),
    roost.roosts.get(roostId!, { siteId: siteId! }),
  ]);
  console.log('site', site.id, site.name);
  console.log('roost', currentRoost.roostId, currentRoost.name);

  const published = await roost.roosts.push(buildDir, roostId!, {
    siteId: siteId!,
    description: `node sdk publish ${new Date().toISOString()}`,
    onProgress: (evt) => {
      if (evt.phase === 'upload') console.log('upload', `${evt.uploaded}/${evt.total}`);
      if (evt.phase === 'publish') console.log('publish attempt', evt.attempt);
    },
  });

  console.log('published', `v${published.versionNumber}`, published.versionId);

  if (shouldDeploy) {
    const deploy = await roost.roosts.deploy(roostId!, {
      siteId: siteId!,
      versionId: published.versionId,
    });
    console.log('deploy queued', deploy.rolloutId, deploy.stage);
  }
} catch (err) {
  if (err instanceof RoostApiError) {
    console.error('api error', err.status, err.code, err.problem.detail ?? err.message);
  } else {
    console.error('unexpected error', err);
  }
  process.exit(1);
}
