/**
 * Integration smoke test against a real dev api, gated by `OWLETTE_CLI_SMOKE=1`
 * (otherwise `describe.skip`, so `npm test` stays offline in CI). Also needs
 * OWLETTE_CLI_SMOKE_API_URL, _TOKEN (`owk_test_*` / `owk_live_*`), and _SITE.
 *
 * Read-only (`GET /api/whoami`, `GET /api/roosts?siteId=…`) — safe against a
 * shared dev environment.
 */

const SMOKE_ENABLED = process.env.OWLETTE_CLI_SMOKE === '1';
const SMOKE_API_URL = process.env.OWLETTE_CLI_SMOKE_API_URL;
const SMOKE_TOKEN = process.env.OWLETTE_CLI_SMOKE_TOKEN;
const SMOKE_SITE = process.env.OWLETTE_CLI_SMOKE_SITE;

const maybeDescribe = SMOKE_ENABLED ? describe : describe.skip;

maybeDescribe('smoke tests against dev api (OWLETTE_CLI_SMOKE=1)', () => {
  beforeAll(() => {
    if (!SMOKE_API_URL || !SMOKE_TOKEN || !SMOKE_SITE) {
      throw new Error(
        'OWLETTE_CLI_SMOKE=1 requires OWLETTE_CLI_SMOKE_API_URL, OWLETTE_CLI_SMOKE_TOKEN, OWLETTE_CLI_SMOKE_SITE to be set',
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
  // Jest needs at least one test in the file when smoke is off.
  describe('smoke tests (skipped)', () => {
    it('requires OWLETTE_CLI_SMOKE=1 to run', () => {
      expect(SMOKE_ENABLED).toBe(false);
    });
  });
}
