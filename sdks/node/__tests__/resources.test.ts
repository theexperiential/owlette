/**
 * Resource HTTP-shape tests — asserts each public method hits the
 * expected URL + method + body. Uses the same fake-fetch strategy as
 * client.test.ts but exercises every resource class surface.
 */

import { Roost } from '../src/index';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
          currentVersionId: null,
          previousVersionId: null,
          versionUrl: null,
          createdAt: null,
          updatedAt: null,
          deletedAt: null,
          currentVersion: null,
          previousVersion: null,
        },
      },
    ]);
    await roost.roosts.get('rst_abc', { siteId: 's1' });
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_abc?siteId=s1');
  });

  it('rollback → POST /api/roosts/{id}/rollback with targetVersion', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { currentVersionId: 'to', previousVersionId: 'from' } },
    ]);
    await roost.roosts.rollback('rst_abc', { siteId: 's', targetVersion: 3 });
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_abc/rollback');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      siteId: 's',
      targetVersion: 3,
    });
  });

  it('rollback → accepts string aliases as targetVersion', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { currentVersionId: 'to', previousVersionId: 'from' } },
    ]);
    await roost.roosts.rollback('rst_abc', { siteId: 's', targetVersion: 'previous' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      siteId: 's',
      targetVersion: 'previous',
    });
  });

  it('deploy → POST /api/roosts/{id}/deploy with all options', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          rolloutId: 'm1',
          versionId: 'm1',
          siteId: 's',
          roostId: 'rst',
          stage: 'canary',
          canary: ['m-1'],
          fleet: [],
          extractRoot: '~/x',
          versionUrl: 'https://r2/x',
        },
      },
    ]);
    const when = new Date('2026-05-01T00:00:00Z');
    await roost.roosts.deploy('rst_abc', {
      siteId: 's',
      versionId: 'm-new',
      machines: ['m-1'],
      scheduleAt: when,
      dryRun: false,
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.versionId).toBe('m-new');
    expect(body.machines).toEqual(['m-1']);
    expect(body.scheduleAt).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('roost.versions', () => {
  it('list → GET /api/roosts/{id}/versions', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { versions: [], nextCursor: null } },
    ]);
    await roost.versions.list('rst_abc', { siteId: 's1' });
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_abc/versions?siteId=s1');
  });

  it('get → GET /api/roosts/{id}/versions/{ref}', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          versionId: 'vrs_abc',
          versionNumber: 3,
          description: 'fixed video',
          roostId: 'rst_abc',
          siteId: 's1',
          version: {},
          metadata: {
            versionUrl: null,
            createdAt: null,
            createdBy: null,
            totalSize: 0,
            totalFiles: 0,
            parentVersionId: null,
          },
        },
      },
    ]);
    const res = await roost.versions.get('rst_abc', 3, { siteId: 's1' });
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_abc/versions/3?siteId=s1');
    expect(res.versionNumber).toBe(3);
    expect(res.description).toBe('fixed video');
  });

  it('diff → GET /api/roosts/{id}/versions/{ref}/diff', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          versionId: 'vrs_abc',
          versionNumber: 3,
          against: 'current',
          roostId: 'rst_abc',
          siteId: 's1',
          summary: {
            added: 0,
            removed: 0,
            changed: 0,
            unchanged: 0,
            hasChanges: false,
            netBytesDelta: 0,
          },
          added: [],
          removed: [],
          modified: [],
        },
      },
    ]);
    await roost.versions.diff('rst_abc', 'v3', { siteId: 's1', against: 'current' });
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/roosts/rst_abc/versions/v3/diff?siteId=s1&against=current',
    );
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

describe('roost.installerDeployments', () => {
  it('list → GET /api/sites/{siteId}/deployments?page_size=…', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { items: [], next_page_token: 'cursor' } },
    ]);
    const result = await roost.installerDeployments.list('site-1', { pageSize: 10 });
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments?page_size=10');
    expect(result.nextPageToken).toBe('cursor');
  });

  it('create → POST with Idempotency-Key auto-gen + machines body', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 201,
        body: {
          deploymentId: 'deploy-1',
          siteId: 'site-1',
          status: 'in_progress',
          targets: [],
        },
      },
    ]);
    await roost.installerDeployments.create('site-1', {
      name: 'rollout',
      installer_url: 'https://example.com/x.exe',
      installer_name: 'x.exe',
      silent_flags: '/SILENT',
      machines: ['m-1', 'm-2'],
      close_processes: ['TouchDesigner.exe'],
      suppress_projects: ['show-a'],
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://dev.test/api/sites/site-1/deployments');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-installer-deployments-create-/);
    const body = JSON.parse(String(call.init.body));
    expect(body.machines).toEqual(['m-1', 'm-2']);
    expect(body.name).toBe('rollout');
    expect(body.close_processes).toEqual(['TouchDesigner.exe']);
    expect(body.suppress_projects).toEqual(['show-a']);
  });

  it('cancel → POST /cancel surfaces RoostApiError on 409', async () => {
    const { roost } = makeRoost([
      {
        status: 409,
        body: { code: 'no_cancellable_targets', detail: 'every target is past queue' },
      },
    ]);
    await expect(
      roost.installerDeployments.cancel('site-1', 'deploy-1'),
    ).rejects.toMatchObject({ name: 'RoostApiError', status: 409, code: 'no_cancellable_targets' });
  });

  it('uninstall → POST and honours custom idempotency-key', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          deploymentId: 'deploy-1',
          siteId: 'site-1',
          status: 'uninstalling',
          queued: 3,
          machine_ids: ['m-1', 'm-2', 'm-3'],
        },
      },
    ]);
    await roost.installerDeployments.uninstall('site-1', 'deploy-1', {
      idempotencyKey: 'caller-supplied',
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('caller-supplied');
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/sites/site-1/deployments/deploy-1/uninstall',
    );
  });

  it('delete -> DELETE with Idempotency-Key and empty body', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: { deploymentId: 'deploy-1', siteId: 'site-1', deleted: true },
      },
    ]);
    await roost.installerDeployments.delete('site-1', 'deploy-1', {
      idempotencyKey: 'delete-key',
    });
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments/deploy-1');
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('delete-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });
});

describe('roost.installer', () => {
  it('list → GET /api/installer with pagination', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { versions: [], nextPageToken: '' } },
    ]);
    await roost.installer.list({ pageSize: 5, includeDeleted: true });
    expect(calls[0]!.url).toContain('/api/installer?');
    expect(calls[0]!.url).toContain('page_size=5');
    expect(calls[0]!.url).toContain('includeDeleted=true');
  });

  it('latest -> GET /api/installer/latest', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          version: '2.10.0',
          download_url: 'https://cdn.example/x.exe',
          checksum_sha256: 'a'.repeat(64),
          release_notes: null,
          file_size: 123,
          uploaded_at: 1,
          uploaded_by: 'u1',
          release_date: '2026-04-28T00:00:00.000Z',
          deletedAt: null,
        },
      },
    ]);
    const latest = await roost.installer.latest();
    expect(calls[0]!.url).toBe('https://dev.test/api/installer/latest');
    expect(latest.version).toBe('2.10.0');
  });

  it('upload -> POST, signed-url PUT, finalize with one idempotency key', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'owlette-node-installer-test-'));
    const filePath = join(tempDir, 'Owlette-Installer-v2.11.0.exe');
    writeFileSync(filePath, Buffer.from('fake installer bytes'));
    try {
      const { roost, calls } = makeRoost([
        {
          status: 200,
          body: {
            uploadUrl: 'https://signed.example/upload',
            uploadId: 'upload-1',
            storagePath: 'agent-installers/versions/2.11.0/Owlette-Installer-v2.11.0.exe',
            expiresAt: '2026-04-28T00:15:00.000Z',
          },
        },
        { status: 200, body: '' },
        {
          status: 200,
          body: {
            version: '2.11.0',
            download_url: 'https://cdn.example/Owlette-Installer-v2.11.0.exe',
            checksum_sha256: 'a'.repeat(64),
            file_size: 20,
          },
        },
      ]);

      await roost.installer.upload({ filePath, version: '2.11.0' });

      expect(calls).toHaveLength(3);
      expect(calls[0]!.url).toBe('https://dev.test/api/installer/upload');
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[1]!.url).toBe('https://signed.example/upload');
      expect(calls[1]!.init.method).toBe('PUT');
      expect(calls[2]!.url).toBe('https://dev.test/api/installer/upload');
      expect(calls[2]!.init.method).toBe('PUT');
      const startHeaders = calls[0]!.init.headers as Record<string, string>;
      const finalizeHeaders = calls[2]!.init.headers as Record<string, string>;
      expect(startHeaders['Idempotency-Key']).toMatch(/^sdk-installer-upload-/);
      expect(finalizeHeaders['Idempotency-Key']).toBe(startHeaders['Idempotency-Key']);
      expect(JSON.parse(String(calls[2]!.init.body)).checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('setLatest → POST /api/installer/{version}/set-latest with auto idempotency-key', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: { version: '2.10.0', latest: { version: '2.10.0' } },
      },
    ]);
    await roost.installer.setLatest('2.10.0');
    const call = calls[0]!;
    expect(call.url).toBe('https://dev.test/api/installer/2.10.0/set-latest');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-installer-set-latest-/);
  });

  it('delete → DELETE /api/installer/{version}', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { version: '2.5.0', deletedAt: 1, alreadyDeleted: false } },
    ]);
    const result = await roost.installer.delete('2.5.0');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://dev.test/api/installer/2.5.0');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-installer-delete-/);
    expect(result.alreadyDeleted).toBe(false);
  });
});

describe('roost.processes (factory)', () => {
  it('list → GET /api/sites/{siteId}/machines/{machineId}/processes', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { ok: true, data: { processes: [], nextPageToken: null } } },
    ]);
    await roost.processes('site-1', 'm-1').list();
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/machines/m-1/processes');
  });

  it('create → POST with required fields + auto idempotency-key', async () => {
    const { roost, calls } = makeRoost([
      { status: 201, body: { ok: true, data: { processId: 'p-1' } } },
    ]);
    await roost.processes('site-1', 'm-1').create({
      name: 'TouchDesigner',
      exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe',
      launch_mode: 'always',
    });
    const call = calls[0]!;
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-processes-create-/);
    const body = JSON.parse(String(call.init.body));
    expect(body.name).toBe('TouchDesigner');
    expect(body.launch_mode).toBe('always');
  });

  it('start verb → POST /processes/{id}/start', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { ok: true, data: { processId: 'p-1' } } },
    ]);
    await roost.processes('site-1', 'm-1').start('p-1');
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/sites/site-1/machines/m-1/processes/p-1/start',
    );
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('schedule → POST /schedule with mode + blocks', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { ok: true, data: { processId: 'p-1', mode: 'scheduled' } } },
    ]);
    await roost.processes('site-1', 'm-1').schedule('p-1', {
      mode: 'scheduled',
      blocks: [{ days: ['Mon'], ranges: [{ start: '09:00', stop: '17:00' }] }],
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.mode).toBe('scheduled');
    expect(body.blocks).toHaveLength(1);
  });
});

describe('roost.chat', () => {
  it('new → POST /api/chat/new with siteId', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 201,
        body: {
          ok: true,
          data: { conversationId: 'conv-1', title: null, siteId: 'site-1' },
        },
      },
    ]);
    const result = await roost.chat.new({ siteId: 'site-1', title: 'help me' });
    expect(calls[0]!.url).toBe('https://dev.test/api/chat/new');
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.siteId).toBe('site-1');
    expect(body.title).toBe('help me');
    expect(result.conversationId).toBe('conv-1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-chat-new-/);
  });

  it('list → GET /api/chat?page_size=…', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { ok: true, data: { conversations: [], nextPageToken: '' } } },
    ]);
    await roost.chat.list({ pageSize: 25, ownerOnly: true });
    expect(calls[0]!.url).toContain('/api/chat?');
    expect(calls[0]!.url).toContain('page_size=25');
    expect(calls[0]!.url).toContain('owner=me');
  });

  it('rename → PATCH /api/chat/{id}', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: { ok: true, data: { conversationId: 'conv-1', title: 'renamed' } },
      },
    ]);
    await roost.chat.rename('conv-1', 'renamed');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('https://dev.test/api/chat/conv-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ title: 'renamed' });
  });

  it('delete → DELETE /api/chat/{id} returns alreadyDeleted', async () => {
    const { roost } = makeRoost([
      {
        status: 200,
        body: { ok: true, data: { conversationId: 'conv-1', alreadyDeleted: true } },
      },
    ]);
    const result = await roost.chat.delete('conv-1');
    expect(result.alreadyDeleted).toBe(true);
  });

  it('send → streams text deltas from line-prefixed AI-SDK protocol', async () => {
    // Build a streaming ReadableStream of AI-SDK frames.
    const encoder = new TextEncoder();
    const frames = [
      '0:"hello "\n',
      '0:"world"\n',
      'd:{"finishReason":"stop"}\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    const fetchMock = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      body: stream,
    })) as unknown as typeof fetch;

    const { Roost } = await import('../src/index');
    const roost = new Roost({
      token: 'owk_test_x',
      apiUrl: 'https://dev.test',
      fetch: fetchMock,
      retry: { maxAttempts: 1 },
    });
    const handle = await roost.chat.send('conv-1', 'hi');
    const collected: string[] = [];
    for await (const delta of handle.deltas) collected.push(delta);
    expect(collected.join('')).toBe('hello world');
    await expect(handle.complete).resolves.toBe('hello world');
  });
});

describe('roost.users', () => {
  it('list → GET /api/users with role + site filters', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { users: [], nextPageToken: '' } },
    ]);
    await roost.users.list({ role: 'admin', site: 'site-1', pageSize: 50 });
    expect(calls[0]!.url).toContain('/api/users?');
    expect(calls[0]!.url).toContain('role=admin');
    expect(calls[0]!.url).toContain('site=site-1');
    expect(calls[0]!.url).toContain('page_size=50');
  });

  it('promote → POST /api/users/{uid}/promote auto-generates idempotency-key', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: { uid: 'u-1', role: 'admin', previousRole: 'member', changed: true },
      },
    ]);
    await roost.users.promote('u-1', 'admin');
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u-1/promote');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-users-promote-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ role: 'admin' });
  });

  it('demote → surfaces last_superadmin error code on 409', async () => {
    const { roost } = makeRoost([
      {
        status: 409,
        body: {
          code: 'last_superadmin',
          detail: 'cannot demote: only 1 active superadmin remains',
        },
      },
    ]);
    await expect(roost.users.demote('u-1')).rejects.toMatchObject({
      name: 'RoostApiError',
      status: 409,
      code: 'last_superadmin',
    });
  });

  it('assignSites → POST with body.siteIds array', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { uid: 'u-1', assignedSiteIds: ['site-1'] } },
    ]);
    await roost.users.assignSites('u-1', ['site-1', 'site-2']);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.siteIds).toEqual(['site-1', 'site-2']);
  });

  it('delete with successorUid forwards the query param', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          uid: 'u-1',
          alreadyDeleted: false,
          deletedAt: 0,
          transferredSites: ['site-1'],
          revokedKeyIds: [],
        },
      },
    ]);
    await roost.users.delete('u-1', { successorUid: 'u-2' });
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u-1?successorUid=u-2');
  });
});

describe('roost.members (factory)', () => {
  it('list → GET /api/sites/{siteId}/members', async () => {
    const { roost, calls } = makeRoost([{ status: 200, body: { members: [] } }]);
    await roost.members('site-1').list();
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/members');
  });

  it('add → POST with uid + role and auto idempotency-key', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          uid: 'u-1',
          siteId: 'site-1',
          requestedRole: 'admin',
          roleHonored: true,
          globalRole: 'admin',
        },
      },
    ]);
    await roost.members('site-1').add({ uid: 'u-1', role: 'admin' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-members-add-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uid: 'u-1', role: 'admin' });
  });

  it('remove → DELETE /api/sites/{siteId}/members/{uid}', async () => {
    const { roost, calls } = makeRoost([
      { status: 200, body: { siteId: 'site-1', uid: 'u-1', wasMember: true } },
    ]);
    const result = await roost.members('site-1').remove('u-1');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/members/u-1');
    expect(result.wasMember).toBe(true);
  });
});

describe('roost.machines (extended)', () => {
  it('dispatchCommand → POST /commands with type + auto idempotency-key', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 202,
        body: { ok: true, data: { commandId: 'cmd_abc', status: 'pending' } },
      },
    ]);
    const result = await roost.machines.dispatchCommand(
      'site-1',
      'm-1',
      'reboot_machine',
      { delay_seconds: 30 },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/machines/m-1/commands');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^sdk-machines-dispatch-command-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.type).toBe('reboot_machine');
    expect(body.params).toEqual({ delay_seconds: 30 });
    expect(result.commandId).toBe('cmd_abc');
  });

  it('getCommand → GET /commands/{commandId}', async () => {
    const { roost, calls } = makeRoost([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            commandId: 'cmd_abc',
            status: 'completed',
            result: { ok: true },
            createdAt: null,
            updatedAt: null,
          },
        },
      },
    ]);
    const result = await roost.machines.getCommand('site-1', 'm-1', 'cmd_abc');
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/sites/site-1/machines/m-1/commands/cmd_abc',
    );
    expect(result.status).toBe('completed');
  });

  it('captureScreenshot → dispatch + poll + fetch signed URL', async () => {
    // 1: dispatch returns commandId
    // 2: first poll returns pending
    // 3: second poll returns completed with screenshot_url
    // 4: signed-url fetch returns binary bytes
    const calls: Call[] = [];
    let i = 0;
    const responses: Array<{ status: number; body: unknown; bytes?: Uint8Array }> = [
      {
        status: 202,
        body: { ok: true, data: { commandId: 'cmd_screen', status: 'pending' } },
      },
      {
        status: 200,
        body: {
          ok: true,
          data: {
            commandId: 'cmd_screen',
            status: 'pending',
            createdAt: null,
            updatedAt: null,
          },
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          data: {
            commandId: 'cmd_screen',
            status: 'completed',
            result: {
              screenshot_url: 'https://signed.test/img.png',
              expires_at: '2030-01-01T00:00:00Z',
            },
            createdAt: null,
            updatedAt: null,
          },
        },
      },
      { status: 200, body: '', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ];
    const fetch: typeof global.fetch = async (input, init = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: new Headers(),
        text: async () =>
          typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        arrayBuffer: async () =>
          r.bytes ? r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) : new ArrayBuffer(0),
      } as Response;
    };
    const { Roost } = await import('../src/index');
    const roost = new Roost({
      token: 'owk_live_x',
      apiUrl: 'https://dev.test',
      fetch,
      retry: { maxAttempts: 1 },
    });

    const result = await roost.machines.captureScreenshot('site-1', 'm-1', {
      pollIntervalMs: 1, // keep tests fast
      timeoutMs: 1000,
    });
    expect(result.status).toBe('completed');
    expect(result.screenshotUrl).toBe('https://signed.test/img.png');
    expect(result.bytes?.length).toBe(4);
    expect(result.bytes?.[0]).toBe(0x89);
    // Sanity-check call order: dispatch, ≥1 poll, signed-url fetch.
    expect(calls[0]!.url).toContain('/commands');
    expect(calls[calls.length - 1]!.url).toBe('https://signed.test/img.png');
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
