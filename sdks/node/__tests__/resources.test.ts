/**
 * Resource HTTP-shape tests — asserts each public method hits the
 * expected URL + method + body. Uses the same fake-fetch strategy as
 * client.test.ts but exercises every resource class surface.
 */

import { Roost } from '../src/index';

interface Call {
  url: string;
  init: RequestInit;
}

function makeRoost(
  responses: Array<{ status: number; body: unknown }>,
): { roost: Roost; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: typeof global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    const { status, body } = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  };
  const roost = new Roost({
    token: 'owk_live_testtoken',
    apiUrl: 'https://dev.test',
    fetch,
    retry: { maxAttempts: 1 },
  });
  return { roost, calls };
}

describe('roost.sites', () => {
  it('list → GET /api/sites', async () => {
    const { roost, calls } = makeRoost([{ status: 200, body: { sites: [{ id: 's1', name: 'alpha' }] } }]);
    const result = await roost.sites.list();
    expect(calls[0]!.url).toBe('https://dev.test/api/sites');
    expect(result[0]!.id).toBe('s1');
  });

  it('get → GET /api/sites/{id}', async () => {
    const { roost, calls } = makeRoost([{ status: 200, body: { id: 's1', name: 'alpha' } }]);
    await roost.sites.get('s1');
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/s1');
  });
});

describe('roost.roosts', () => {
  it('list → GET /api/roosts?siteId=…', async () => {
    const { roost, calls } = makeRoost([{ status: 200, body: { roosts: [], nextPageToken: '' } }]);
    await roost.roosts.list({ siteId: 'site-1', pageSize: 10 });
    expect(calls[0]!.url).toContain('/api/roosts?siteId=site-1');
    expect(calls[0]!.url).toContain('limit=10');
  });

  it('get → GET /api/roosts/{id}?siteId=…', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          roostId: 'rst',
          siteId: 's',
          name: 'x',
          targets: [],
          extractPath: null,
          schemaVersion: 2,
          currentManifestId: null,
          previousManifestId: null,
          manifestUrl: null,
          createdAt: null,
          updatedAt: null,
          deletedAt: null,
          currentManifest: null,
          previousManifest: null,
        },
      },
    ]);
    await roost.roosts.get('rst_abc', { siteId: 's1' });
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_abc?siteId=s1');
  });

  it('rollback → POST /api/roosts/{id}/rollback with targetManifestId', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { currentManifestId: 'to', previousManifestId: 'from' } },
    ]);
    await roost.roosts.rollback('rst_abc', { siteId: 's', targetManifestId: 'to' });
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_abc/rollback');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      siteId: 's',
      targetManifestId: 'to',
    });
  });

  it('deploy → POST /api/roosts/{id}/deploy with all options', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          rolloutId: 'm1',
          manifestId: 'm1',
          siteId: 's',
          roostId: 'rst',
          stage: 'canary',
          canary: ['m-1'],
          fleet: [],
          extractRoot: '~/x',
          manifestUrl: 'https://r2/x',
        },
      },
    ]);
    const when = new Date('2026-05-01T00:00:00Z');
    await roost.roosts.deploy('rst_abc', {
      siteId: 's',
      manifestId: 'm-new',
      machines: ['m-1'],
      scheduleAt: when,
      dryRun: false,
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.manifestId).toBe('m-new');
    expect(body.machines).toEqual(['m-1']);
    expect(body.scheduleAt).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('roost.chunks', () => {
  it('check → POST /api/chunks/check', async () => {
    const { roost, calls } = makeRoost([{ status: 200, body: { missing: ['h1'] } }]);
    const result = await roost.chunks.check('site-1', ['h1', 'h2']);
    expect(calls[0]!.url).toBe('https://dev.test/api/chunks/check');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ siteId: 'site-1', hashes: ['h1', 'h2'] });
    expect(result).toEqual(['h1']);
  });

  it('mount → POST /api/chunks/{digest}/mount?…', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { digest: 'd', siteId: 's', from: 'a', to: 'b', mounted: true, zeroByte: true } },
    ]);
    await roost.chunks.mount('d'.repeat(64), 'site-1', 'rst_from0001abc', 'rst_to00001234');
    expect(calls[0]!.url).toContain(`/api/chunks/${'d'.repeat(64)}/mount?`);
    expect(calls[0]!.url).toContain('siteId=site-1');
    expect(calls[0]!.url).toContain('from=rst_from0001abc');
    expect(calls[0]!.url).toContain('to=rst_to00001234');
  });
});

describe('roost.keys', () => {
  it('create → POST /api/keys with scopes', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          success: true,
          key: 'owk_live_XXX',
          keyId: 'k',
          name: 'n',
          environment: 'live',
          scopes: [],
          expiresAt: 0,
          keyPrefix: 'p',
        },
      },
    ]);
    await roost.keys.create({
      name: 'ci',
      scopes: [{ resource: 'roost', id: '*', permissions: ['write'] }],
      ttlDays: 30,
      environment: 'live',
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.scopes[0].resource).toBe('roost');
    expect(body.ttlDays).toBe(30);
  });

  it('rotate → POST /api/keys/{id}/rotate', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          success: true,
          key: 'owk_live_NEW',
          keyId: 'new',
          rotatedFromKeyId: 'old',
          expiresAt: 0,
          previousKey: { keyId: 'old', retiresAt: 0 },
        },
      },
    ]);
    await roost.keys.rotate('old', 180);
    expect(calls[0]!.url).toBe('https://dev.test/api/keys/old/rotate');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttlDays: 180 });
  });

  it('revoke → DELETE /api/keys/{id}', async () => {
    const { roost, calls } = makeRoost([{ status: 200, body: { success: true } }]);
    await roost.keys.revoke('doomed');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://dev.test/api/keys/doomed');
  });
});

describe('roost.events signature helpers', () => {
  it('signBody round-trips through verifySignature', async () => {
    const { roost } = makeRoost([]);
    const body = '{"event":"x"}';
    const header = roost.events.signBody(body, 'secret');
    const result = roost.events.verifySignature(header, body, 'secret');
    expect(result.ok).toBe(true);
  });

  it('isSignatureValid boolean form matches verifySignature.ok', async () => {
    const { roost } = makeRoost([]);
    const body = 'hello';
    const header = roost.events.signBody(body, 'secret');
    expect(roost.events.isSignatureValid(header, body, 'secret')).toBe(true);
    expect(roost.events.isSignatureValid(header, 'tampered', 'secret')).toBe(false);
  });
});
