/**
 * Integration smoke test — exercises the cli against a real dev api.
 *
 * Gated by `ROOST_CLI_SMOKE=1`. When unset, every assertion in this
 * file is skipped (via Jest's `describe.skip`), so `npm test` runs
 * fully offline in CI.
 *
 * When ROOST_CLI_SMOKE=1, these env vars are also required:
 *
 *   ROOST_CLI_SMOKE_API_URL   e.g. https://dev.owlette.app
 *   ROOST_CLI_SMOKE_TOKEN     a valid `owk_test_*` or `owk_live_*` key
 *   ROOST_CLI_SMOKE_SITE      a site id the token has read access to
 *
 * The smoke calls are read-only: `GET /api/whoami` and `GET /api/roosts?siteId=…`.
 * They never create or delete anything — safe to run against a shared
 * dev environment.
 */

const SMOKE_ENABLED = process.env.ROOST_CLI_SMOKE === '1';
const SMOKE_API_URL = process.env.ROOST_CLI_SMOKE_API_URL;
const SMOKE_TOKEN = process.env.ROOST_CLI_SMOKE_TOKEN;
const SMOKE_SITE = process.env.ROOST_CLI_SMOKE_SITE;

const maybeDescribe = SMOKE_ENABLED ? describe : describe.skip;

maybeDescribe('smoke tests against dev api (ROOST_CLI_SMOKE=1)', () => {
  beforeAll(() => {
    if (!SMOKE_API_URL || !SMOKE_TOKEN || !SMOKE_SITE) {
      throw new Error(
        'ROOST_CLI_SMOKE=1 requires ROOST_CLI_SMOKE_API_URL, ROOST_CLI_SMOKE_TOKEN, ROOST_CLI_SMOKE_SITE to be set',
      );
    }
  });

  it('GET /api/whoami returns a userId + scopes summary', async () => {
    const res = await fetch(`${SMOKE_API_URL}/api/whoami`, {
      headers: { Authorization: `Bearer ${SMOKE_TOKEN}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { userId?: string; key?: unknown };
    expect(typeof body.userId).toBe('string');
    expect(body.userId!.length).toBeGreaterThan(0);
  });

  it('GET /api/roosts returns a paginated list shape', async () => {
    const res = await fetch(
      `${SMOKE_API_URL}/api/roosts?siteId=${encodeURIComponent(SMOKE_SITE!)}&limit=5`,
      {
        headers: { Authorization: `Bearer ${SMOKE_TOKEN}` },
      },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { roosts?: unknown[]; nextPageToken?: string };
    expect(Array.isArray(body.roosts)).toBe(true);
    expect(typeof body.nextPageToken).toBe('string');
  });

  it('GET /api/version returns the current version without auth', async () => {
    const res = await fetch(`${SMOKE_API_URL}/api/version`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { current?: string; supported?: string[] };
    expect(typeof body.current).toBe('string');
    expect(Array.isArray(body.supported)).toBe(true);
  });
});

if (!SMOKE_ENABLED) {
  // Keep jest happy (every test file needs at least one test). This is
  // the "test" when smoke is off — and documents the gate.
  describe('smoke tests (skipped)', () => {
    it('requires ROOST_CLI_SMOKE=1 to run', () => {
      expect(SMOKE_ENABLED).toBe(false);
    });
  });
}
