/**
 * @jest-environment node
 *
 * tests for web/lib/roostUpload.ts — the client-side upload orchestrator
 * (roost wave 3.1). Mocks the roost routes (chunks/check, chunks/upload-urls,
 * roosts/{id}/manifests) via an injected `fetchFn`, and mocks the
 * IndexedDB-backed queue via an in-memory `QueueStore`.
 */

import {
  locateChunkBytes,
  RoostUploadError,
  uploadFolder,
  type UploadProgress,
} from '@/lib/roostUpload';
import type { QueueStore, UploadTask } from '@/lib/uploadQueue';
import type { NamedBlob, ManifestFileEntry } from '@/lib/chunking';

// -------- blob fake -------------------------------------------------

function blobOf(bytes: Buffer): NamedBlob['blob'] {
  const size = bytes.byteLength;
  return {
    get size() { return size; },
    slice(start: number, end?: number) {
      return blobOf(Buffer.from(bytes.subarray(start, end ?? size)));
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const out = new Uint8Array(bytes.byteLength);
      out.set(bytes);
      return out.buffer;
    },
  };
}

function named(path: string, bytes: Buffer): NamedBlob {
  return { path, blob: blobOf(bytes) };
}

// -------- memory store ---------------------------------------------

function memoryStore(): QueueStore {
  const m = new Map<string, UploadTask>();
  return {
    async get(id) { return m.get(id); },
    async put(task) { m.set(task.id, { ...task }); },
    async list(filter) {
      const a = [...m.values()];
      return filter?.state ? a.filter(t => t.state === filter.state) : a;
    },
    async delete(id) { m.delete(id); },
  };
}

// -------- fake fetch ------------------------------------------------

interface FakeRoute {
  match: (url: string, init: RequestInit | undefined) => boolean;
  respond: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>;
}

function fakeFetch(routes: FakeRoute[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const r of routes) {
      if (r.match(u, init)) return r.respond(u, init);
    }
    throw new Error(`fakeFetch: no route for ${u}`);
  }) as unknown as typeof fetch;
}

const OK = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

// -------- tests -----------------------------------------------------

describe('uploadFolder — happy path', () => {
  it('runs hash → check → upload-urls → PUTs → finalize', async () => {
    const files = [
      named('projects/a.toe', Buffer.from('hello roost')),
      named('projects/b.toe', Buffer.from('another file')),
    ];

    const puts: string[] = [];
    let checkBody: Record<string, unknown> | null = null;
    let finalizeBody: Record<string, unknown> | null = null;

    const fetchFn = fakeFetch([
      {
        match: (u, i) => u.endsWith('/api/chunks/check') && i?.method === 'POST',
        respond: async (_u, i) => {
          checkBody = JSON.parse(i!.body as string);
          // pretend server has nothing — everything is missing.
          return OK({ missing: (checkBody!.hashes as string[]) });
        },
      },
      {
        match: (u, i) => u.endsWith('/api/chunks/upload-urls') && i?.method === 'POST',
        respond: async (_u, i) => {
          const body = JSON.parse(i!.body as string) as { hashes: string[] };
          const urls: Record<string, string> = {};
          for (const h of body.hashes) urls[h] = `https://r2.fake/put/${h}`;
          return OK({ urls });
        },
      },
      {
        match: (u, i) =>
          /\/api\/roosts\/[^/]+\/manifests$/.test(u) && i?.method === 'POST',
        respond: async (_u, i) => {
          finalizeBody = JSON.parse(i!.body as string);
          return new Response(
            JSON.stringify({
              manifestId: 'mfest-abc',
              currentManifestId: 'mfest-abc',
              previousManifestId: null,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      },
      {
        // R2 signed PUT urls
        match: (u, i) => u.startsWith('https://r2.fake/put/') && i?.method === 'PUT',
        respond: async (u) => {
          puts.push(u);
          return new Response(null, { status: 200 });
        },
      },
    ]);

    const phases: UploadProgress['phase'][] = [];
    const result = await uploadFolder({
      siteId: 'site-a',
      roostId: 'roost-folder',
      files,
      name: 'test roost',
      targets: ['machine-a'],
      queueStore: memoryStore(),
      fetchFn,
      onProgress: (p) => phases.push(p.phase),
    });

    expect(result.manifestId).toBe('mfest-abc');
    // every distinct chunk hashed must have been PUT exactly once.
    const uniqueHashes = new Set(puts.map((u) => u.split('/').pop()));
    expect(uniqueHashes.size).toBe(puts.length); // no duplicate PUTs
    expect(puts.length).toBeGreaterThan(0);
    // phase transitions in the expected order
    expect(phases).toEqual(
      expect.arrayContaining(['hashing', 'checking', 'uploading', 'finalizing', 'done']),
    );
    // finalize was called with the manifest body shape the spec requires
    expect(finalizeBody).toMatchObject({
      siteId: 'site-a',
      manifest: { schemaVersion: 2, mediaType: 'application/vnd.owlette.manifest.v1+json' },
    });
  });
});

describe('uploadFolder — server-side dedup', () => {
  it('skips the upload phase entirely when the server already has every chunk', async () => {
    const files = [named('projects/a.toe', Buffer.from('hello roost'))];
    let uploadUrlsCalled = false;
    let putCount = 0;

    const fetchFn = fakeFetch([
      {
        match: (u, i) => u.endsWith('/api/chunks/check') && i?.method === 'POST',
        respond: () => OK({ missing: [] }), // server has everything
      },
      {
        match: (u) => u.endsWith('/api/chunks/upload-urls'),
        respond: () => {
          uploadUrlsCalled = true;
          return OK({ urls: {} });
        },
      },
      {
        match: (u, i) =>
          /\/api\/roosts\/[^/]+\/manifests$/.test(u) && i?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              manifestId: 'mfest-dedup',
              currentManifestId: 'mfest-dedup',
              previousManifestId: null,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      },
      {
        match: (u, i) => u.startsWith('https://r2.fake/put/') && i?.method === 'PUT',
        respond: () => {
          putCount++;
          return new Response(null, { status: 200 });
        },
      },
    ]);

    const result = await uploadFolder({
      siteId: 'site-a',
      roostId: 'roost-folder',
      files,
      name: 'test roost',
      targets: ['machine-a'],
      queueStore: memoryStore(),
      fetchFn,
    });

    expect(result.manifestId).toBe('mfest-dedup');
    expect(uploadUrlsCalled).toBe(false); // no URL request needed
    expect(putCount).toBe(0); // no PUTs
    expect(result.uploadedBytes).toBe(0);
  });
});

describe('uploadFolder — error paths', () => {
  it('surfaces problem+json detail on check failure', async () => {
    const files = [named('a.toe', Buffer.from('x'))];
    const fetchFn = fakeFetch([
      {
        match: (u) => u.endsWith('/api/chunks/check'),
        respond: () =>
          new Response(
            JSON.stringify({
              type: 'https://owlette.app/problems/forbidden',
              title: 'forbidden',
              status: 403,
              detail: 'this site does not allow uploads right now',
            }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/problem+json' },
            },
          ),
      },
    ]);

    await expect(
      uploadFolder({
        siteId: 'site-a',
        roostId: 'f',
        files,
        name: 'roost-test',
        targets: ['m1'],
        queueStore: memoryStore(),
        fetchFn,
      }),
    ).rejects.toMatchObject({
      name: 'RoostUploadError',
      phase: 'checking',
      message: expect.stringContaining('does not allow uploads'),
    });
  });

  it('rejects when no usable files are provided', async () => {
    await expect(
      uploadFolder({
        siteId: 's',
        roostId: 'f',
        files: [], // zero files
        name: 'empty',
        targets: [],
        queueStore: memoryStore(),
        fetchFn: fakeFetch([]),
      }),
    ).rejects.toThrow(RoostUploadError);
  });
});

describe('locateChunkBytes', () => {
  it('returns the correct slice for a known chunk', () => {
    const data = Buffer.alloc(1000);
    for (let i = 0; i < 1000; i++) data[i] = i & 0xff;
    const files: NamedBlob[] = [named('f.bin', data)];
    const entries: ManifestFileEntry[] = [
      {
        path: 'f.bin',
        size: 1000,
        chunks: [
          { hash: 'first', size: 400 },
          { hash: 'second', size: 600 },
        ],
      },
    ];
    const second = locateChunkBytes(files, entries, 'second');
    expect(second).not.toBeNull();
    expect(second!.size).toBe(600);
  });

  it('returns null when the hash is not in the manifest', () => {
    const files: NamedBlob[] = [named('f.bin', Buffer.from('x'))];
    const entries: ManifestFileEntry[] = [
      { path: 'f.bin', size: 1, chunks: [{ hash: 'real', size: 1 }] },
    ];
    expect(locateChunkBytes(files, entries, 'ghost')).toBeNull();
  });
});
