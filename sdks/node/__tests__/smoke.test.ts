/**
 * Integration smoke test — hits a real dev api.
 *
 * Gated by `ROOST_SDK_SMOKE=1`. Unset → all assertions skipped so the
 * hermetic jest run stays fully offline.
 *
 * Env vars when enabled:
 *   ROOST_SDK_SMOKE_API_URL    e.g. https://dev.owlette.app
 *   ROOST_SDK_SMOKE_TOKEN      valid owk_test_* / owk_live_* key
 *   ROOST_SDK_SMOKE_SITE       site id with read access
 */

import { Roost } from '../src/index';

const SMOKE_ENABLED = process.env.ROOST_SDK_SMOKE === '1';
const SMOKE_API_URL = process.env.ROOST_SDK_SMOKE_API_URL;
const SMOKE_TOKEN = process.env.ROOST_SDK_SMOKE_TOKEN;
const SMOKE_SITE = process.env.ROOST_SDK_SMOKE_SITE;

const maybeDescribe = SMOKE_ENABLED ? describe : describe.skip;

maybeDescribe('sdk smoke (ROOST_SDK_SMOKE=1)', () => {
  beforeAll(() => {
    if (!SMOKE_API_URL || !SMOKE_TOKEN || !SMOKE_SITE) {
      throw new Error(
        'ROOST_SDK_SMOKE=1 requires ROOST_SDK_SMOKE_API_URL, ROOST_SDK_SMOKE_TOKEN, ROOST_SDK_SMOKE_SITE',
      );
    }
  });

  it('sites.list returns at least one entry', async () => {
    const roost = new Roost({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const sites = await roost.sites.list();
    expect(Array.isArray(sites)).toBe(true);
    expect(sites.length).toBeGreaterThan(0);
  });

  it('roosts.list paginates the configured site', async () => {
    const roost = new Roost({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await roost.roosts.list({ siteId: SMOKE_SITE!, pageSize: 5 });
    expect(Array.isArray(result.roosts)).toBe(true);
    expect(typeof result.nextPageToken).toBe('string');
  });
});

if (!SMOKE_ENABLED) {
  describe('sdk smoke (skipped)', () => {
    it('requires ROOST_SDK_SMOKE=1 to run', () => {
      expect(SMOKE_ENABLED).toBe(false);
    });
  });
}
