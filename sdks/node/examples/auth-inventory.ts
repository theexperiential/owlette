/**
 * Auth and inventory workflow:
 *   1. verify the token with /api/whoami and /api/version
 *   2. list visible sites
 *   3. list machines for the selected site
 *
 * Required env:
 *   OWLETTE_TOKEN or ROOST_TOKEN
 *
 * Optional:
 *   OWLETTE_API_URL or ROOST_BASE defaults to https://owlette.app
 *   OWLETTE_SITE_ID or ROOST_SITE_ID overrides the site selection
 */

import { Owlette, OwletteApiError } from '@owlette/sdk';

const token = process.env.OWLETTE_TOKEN ?? process.env.ROOST_TOKEN;
const apiUrl = process.env.OWLETTE_API_URL ?? process.env.ROOST_BASE ?? 'https://owlette.app';
const configuredSiteId = process.env.OWLETTE_SITE_ID ?? process.env.ROOST_SITE_ID;

if (!token) {
  console.error('missing env var: OWLETTE_TOKEN or ROOST_TOKEN');
  process.exit(1);
}

const owlette = new Owlette({ token, apiUrl });

async function main(): Promise<number> {
  try {
    const [identity, version, sites] = await Promise.all([
      owlette.account.whoami(),
      owlette.account.version(),
      owlette.sites.list(),
    ]);

    console.log('api', version.current, 'supported', version.supported.join(','));
    console.log('caller', identity.email ?? identity.userId ?? 'api-key');
    console.log('key', identity.key?.keyPrefix ?? 'session');
    console.log('sites', sites.length);

    for (const site of sites) {
      console.log(`site ${site.id} ${site.name}`);
    }

    const siteId = configuredSiteId ?? identity.primarySiteId ?? sites[0]?.id;
    if (!siteId) {
      console.log('no site available for machine inventory');
      return 0;
    }

    const machines = await owlette.machines.list(siteId);
    console.log('selected site', siteId, 'machines', machines.length);
    for (const machine of machines) {
      console.log(
        `machine ${machine.id} ${machine.name} online=${machine.online} heartbeat=${machine.lastHeartbeat ?? 'never'}`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof OwletteApiError) {
      console.error('api error', err.status, err.code, err.problem.detail ?? err.message);
      if (err.requestId) console.error('request_id', err.requestId);
    } else {
      console.error('unexpected error', err);
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
