/** @jest-environment node */

/**
 * Tests for the checksum-compute action core
 * (web/lib/actions/computeInstallerChecksum.server.ts).
 *
 * URLs use public IP literals (e.g. https://8.8.8.8/...) so the SSRF
 * validator never hits DNS. `fetch` is stubbed with minimal response
 * objects exposing only the surface the action consumes.
 */

import { createHash } from 'node:crypto';
import {
  computeInstallerChecksum,
  InstallerChecksumError,
  MAX_INSTALLER_BYTES,
} from '@/lib/actions/computeInstallerChecksum.server';

interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  noBody?: boolean;
}

function mockResponse({ status = 200, headers = {}, chunks = [], noBody = false }: MockResponseSpec) {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  let index = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => headerMap.get(key.toLowerCase()) ?? null },
    body: noBody
      ? null
      : {
          getReader: () => ({
            read: async () =>
              index < chunks.length
                ? { done: false as const, value: chunks[index++] }
                : { done: true as const, value: undefined },
            cancel: async () => {},
          }),
          cancel: async () => {},
        },
  };
}

const fetchMock = jest.fn();
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

async function expectChecksumError(
  promise: Promise<unknown>,
  code: InstallerChecksumError['code'],
): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected computeInstallerChecksum to reject');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InstallerChecksumError);
  expect((err as InstallerChecksumError).code).toBe(code);
}

describe('computeInstallerChecksum', () => {
  it('streams the body and returns its sha256 + size', async () => {
    const chunkA = new Uint8Array([1, 2, 3, 4]);
    const chunkB = new Uint8Array([5, 6, 7]);
    fetchMock.mockResolvedValueOnce(mockResponse({ chunks: [chunkA, chunkB] }));

    const result = await computeInstallerChecksum('https://8.8.8.8/installer.exe');

    const expected = createHash('sha256').update(chunkA).update(chunkB).digest('hex');
    expect(result.sha256_checksum).toBe(expected);
    expect(result.size_bytes).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://8.8.8.8/installer.exe',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects non-https and private-ip urls without fetching', async () => {
    await expectChecksumError(
      computeInstallerChecksum('http://8.8.8.8/x.exe'),
      'invalid_url',
    );
    await expectChecksumError(
      computeInstallerChecksum('https://192.168.1.10/x.exe'),
      'invalid_url',
    );
    await expectChecksumError(computeInstallerChecksum(undefined), 'invalid_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows redirects, resolving relative locations against the current url', async () => {
    const chunk = new Uint8Array([9, 9]);
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({ status: 302, headers: { location: '/moved/installer.exe' } }),
      )
      .mockResolvedValueOnce(mockResponse({ chunks: [chunk] }));

    const result = await computeInstallerChecksum('https://8.8.8.8/installer.exe');

    expect(result.size_bytes).toBe(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://8.8.8.8/moved/installer.exe',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('re-validates every redirect hop — a bounce to a private ip is rejected', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 302, headers: { location: 'https://10.0.0.5/evil.exe' } }),
    );

    await expectChecksumError(
      computeInstallerChecksum('https://8.8.8.8/installer.exe'),
      'invalid_url',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ status: 302, headers: { location: 'https://8.8.8.8/loop.exe' } }),
    );

    await expectChecksumError(
      computeInstallerChecksum('https://8.8.8.8/installer.exe'),
      'too_many_redirects',
    );
  });

  it('refuses a declared content-length over the cap without reading the body', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        headers: { 'content-length': String(MAX_INSTALLER_BYTES + 1) },
        chunks: [new Uint8Array([1])],
      }),
    );

    await expectChecksumError(
      computeInstallerChecksum('https://8.8.8.8/huge.exe'),
      'too_large',
    );
  });

  it('surfaces http error statuses as fetch_failed', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));
    await expectChecksumError(
      computeInstallerChecksum('https://8.8.8.8/missing.exe'),
      'fetch_failed',
    );
  });

  it('rejects an empty download', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ chunks: [] }));
    await expectChecksumError(
      computeInstallerChecksum('https://8.8.8.8/empty.exe'),
      'fetch_failed',
    );
  });

  it('maps a caller abort to cancelled', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (init.signal?.aborted) throw err;
      throw err;
    });

    await expectChecksumError(
      computeInstallerChecksum('https://8.8.8.8/installer.exe', { signal: controller.signal }),
      'cancelled',
    );
  });
});
