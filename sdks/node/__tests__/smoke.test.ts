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
 *   ROOST_SDK_SMOKE_ROOST      optional roost id for publish smoke
 *   ROOST_SDK_SMOKE_PUSH_DIR   optional directory for publish smoke
 *   ROOST_SDK_SMOKE_RUN_PUSH   set to 1 to run the mutating publish smoke
 */

import { Owlette } from '../src/index';

const SMOKE_ENABLED = process.env.ROOST_SDK_SMOKE === '1';
const SMOKE_API_URL = process.env.ROOST_SDK_SMOKE_API_URL;
const SMOKE_TOKEN = process.env.ROOST_SDK_SMOKE_TOKEN;
const SMOKE_SITE = process.env.ROOST_SDK_SMOKE_SITE;
const SMOKE_ROOST = process.env.ROOST_SDK_SMOKE_ROOST;
const SMOKE_PUSH_DIR = process.env.ROOST_SDK_SMOKE_PUSH_DIR;
const SMOKE_RUN_PUSH = process.env.ROOST_SDK_SMOKE_RUN_PUSH === '1';

const maybeDescribe = SMOKE_ENABLED ? describe : describe.skip;
const maybePublishIt =
  SMOKE_ENABLED && SMOKE_RUN_PUSH && SMOKE_ROOST && SMOKE_PUSH_DIR ? it : it.skip;

maybeDescribe('sdk smoke (ROOST_SDK_SMOKE=1)', () => {
  beforeAll(() => {
    if (!SMOKE_API_URL || !SMOKE_TOKEN || !SMOKE_SITE) {
      throw new Error(
        'ROOST_SDK_SMOKE=1 requires ROOST_SDK_SMOKE_API_URL, ROOST_SDK_SMOKE_TOKEN, ROOST_SDK_SMOKE_SITE',
      );
    }
  });

  it('sites.list returns at least one entry', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const sites = await owlette.sites.list();
    expect(Array.isArray(sites)).toBe(true);
    expect(sites.length).toBeGreaterThan(0);
  });

  it('account.whoami and version resolve auth context', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const [identity, version] = await Promise.all([
      owlette.account.whoami(),
      owlette.account.version(),
    ]);
    expect(identity.userId).toEqual(expect.any(String));
    expect(typeof version.current).toBe('string');
    expect(Array.isArray(version.supported)).toBe(true);
  });

  it('sites.get inspects the configured site', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const site = await owlette.sites.get(SMOKE_SITE!);
    expect(site.id).toBe(SMOKE_SITE);
  });

  it('roosts.list paginates the configured site', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await owlette.roosts.list({ siteId: SMOKE_SITE!, pageSize: 5 });
    expect(Array.isArray(result.roosts)).toBe(true);
    expect(typeof result.nextPageToken).toBe('string');
  });

  maybePublishIt('roosts.push can publish a configured directory', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await owlette.roosts.push(SMOKE_PUSH_DIR!, SMOKE_ROOST!, {
      siteId: SMOKE_SITE!,
      description: 'node sdk smoke publish',
    });
    expect(typeof result.versionId).toBe('string');
    expect(result.versionNumber).toBeGreaterThan(0);
  });

  it('installerDeployments.list returns an items array', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await owlette.installerDeployments.list(SMOKE_SITE!, { pageSize: 1 });
    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.nextPageToken).toBe('string');
  });

  it('installer.list returns a versions array (superadmin keys only)', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await owlette.installer.list({ pageSize: 1 });
    expect(Array.isArray(result.versions)).toBe(true);
  });

  it('users.list returns a users array (superadmin keys only)', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await owlette.users.list({ pageSize: 1 });
    expect(Array.isArray(result.users)).toBe(true);
  });

  it('chat.list returns a conversations array', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const result = await owlette.chat.list({ pageSize: 1 });
    expect(Array.isArray(result.conversations)).toBe(true);
  });

  it('members(site).list returns an array', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    const members = await owlette.members(SMOKE_SITE!).list();
    expect(Array.isArray(members)).toBe(true);
  });

  it('processes(site, machine) factory binds the tuple', async () => {
    const owlette = new Owlette({ token: SMOKE_TOKEN!, apiUrl: SMOKE_API_URL! });
    // We can't actually list against an arbitrary machineId here, so just
    // verify the factory returns a usable object. A real read smoke would
    // need a known machine id from the smoke env config — leave that to
    // the operator running the smoke suite.
    const handle = owlette.processes(SMOKE_SITE!, '__smoke_unused_machine__');
    expect(typeof handle.list).toBe('function');
  });
});

if (!SMOKE_ENABLED) {
  describe('sdk smoke (skipped)', () => {
    it('requires ROOST_SDK_SMOKE=1 to run', () => {
      expect(SMOKE_ENABLED).toBe(false);
    });
  });
}
