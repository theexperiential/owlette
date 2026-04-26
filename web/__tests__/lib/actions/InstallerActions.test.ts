/** @jest-environment node */

/**
 * Unit tests for installer action cores added in security-boundary-migration
 * wave 3.11.
 */

interface MockDocEntry {
  data: Record<string, unknown> | null;
}

const mockDocStore: Record<string, MockDocEntry> = {};
const mockSetCalls: Array<{ path: string; data: Record<string, unknown> }> = [];
const mockUpdateCalls: Array<{ path: string; data: Record<string, unknown> }> = [];

function mockBuildDoc(path: string) {
  return {
    path,
    id: path.split('/').at(-1) ?? '',
    collection: (sub: string) => mockBuildCollection(`${path}/${sub}`),
    get: jest.fn(async () => ({
      exists: !!mockDocStore[path]?.data,
      id: path.split('/').at(-1) ?? '',
      data: () => mockDocStore[path]?.data ?? undefined,
    })),
    set: jest.fn(async (data: Record<string, unknown>) => {
      mockDocStore[path] = { data };
      mockSetCalls.push({ path, data });
    }),
    update: jest.fn(async (data: Record<string, unknown>) => {
      const existing = mockDocStore[path]?.data ?? {};
      mockDocStore[path] = { data: { ...existing, ...data } };
      mockUpdateCalls.push({ path, data });
    }),
  };
}

function mockBuildCollection(path: string) {
  return {
    path,
    doc: (id: string) => mockBuildDoc(`${path}/${id}`),
    get: jest.fn(async () => {
      const prefix = `${path}/`;
      const docs = Object.entries(mockDocStore)
        .filter(([docPath, entry]) => {
          if (!entry.data || !docPath.startsWith(prefix)) return false;
          return !docPath.slice(prefix.length).includes('/');
        })
        .map(([docPath, entry]) => ({
          id: docPath.slice(prefix.length),
          exists: true,
          data: () => entry.data ?? {},
          ref: mockBuildDoc(docPath),
        }));
      return { docs };
    }),
  };
}

const mockRunTransaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    get: (ref: { get: () => Promise<unknown> }) => ref.get(),
    set: (ref: { set: (data: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
      ref.set(data),
    update: (
      ref: { update: (data: Record<string, unknown>) => Promise<void> },
      data: Record<string, unknown>,
    ) => ref.update(data),
  };
  return cb(tx);
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => mockBuildCollection(name),
    runTransaction: mockRunTransaction,
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (millis: number) => ({ __timestampMillis: millis }) },
}));

import type { UserActor } from '@/lib/capabilities';
import {
  InstallerValidationError,
  uploadInstaller,
} from '@/lib/actions/uploadInstaller.server';
import {
  InstallerVersionDeletedError,
  InstallerVersionNotFoundError as LatestInstallerNotFoundError,
  setLatestInstaller,
} from '@/lib/actions/setLatestInstaller.server';
import {
  InstallerMinVersionsViolatedError,
  InstallerVersionNotFoundError as DeleteInstallerNotFoundError,
  deleteInstaller,
} from '@/lib/actions/deleteInstaller.server';

const actor: UserActor = {
  type: 'user',
  userId: 'user-superadmin',
  role: 'superadmin',
  sites: [],
};

function seedVersion(version: string, data: Record<string, unknown> = {}): void {
  mockDocStore[`installer_metadata/data/versions/${version}`] = {
    data: {
      version,
      download_url: `https://storage.example.com/${version}.exe`,
      checksum_sha256: 'a'.repeat(64),
      release_notes: null,
      file_size: 1234,
      uploaded_at: 1700000000000,
      uploaded_by: 'uploader',
      ...data,
    },
  };
}

beforeEach(() => {
  for (const key of Object.keys(mockDocStore)) delete mockDocStore[key];
  mockSetCalls.length = 0;
  mockUpdateCalls.length = 0;
  mockRunTransaction.mockClear();
});

describe('uploadInstaller', () => {
  it('writes a version doc and latest pointer by default', async () => {
    const result = await uploadInstaller(
      { actor },
      {
        version: '3.1.4',
        download_url: 'https://storage.example.com/3.1.4.exe',
        checksum_sha256: 'b'.repeat(64),
        file_size: 2048,
        release_notes: 'release notes',
      },
    );

    expect(result).toMatchObject({ version: '3.1.4', set_as_latest: true });
    expect(mockDocStore['installer_metadata/data/versions/3.1.4']?.data).toMatchObject({
      version: '3.1.4',
      download_url: 'https://storage.example.com/3.1.4.exe',
      uploaded_by: 'user-superadmin',
    });
    expect(mockDocStore['installer_metadata/latest']?.data).toMatchObject({
      version: '3.1.4',
      release_date: expect.any(String),
    });
  });

  it('can write only the version doc when setAsLatest=false', async () => {
    await uploadInstaller(
      { actor },
      {
        version: '3.1.5',
        download_url: 'https://storage.example.com/3.1.5.exe',
        checksum_sha256: 'c'.repeat(64),
        file_size: 4096,
        setAsLatest: false,
      },
    );

    expect(mockDocStore['installer_metadata/data/versions/3.1.5']).toBeDefined();
    expect(mockDocStore['installer_metadata/latest']).toBeUndefined();
  });

  it('rejects malformed versions', async () => {
    await expect(
      uploadInstaller(
        { actor },
        {
          version: 'not-semver',
          download_url: 'https://storage.example.com/x.exe',
          checksum_sha256: 'd'.repeat(64),
          file_size: 1,
        },
      ),
    ).rejects.toBeInstanceOf(InstallerValidationError);
  });
});

describe('setLatestInstaller', () => {
  it('promotes a non-deleted version to latest', async () => {
    seedVersion('3.2.0');

    const result = await setLatestInstaller({ actor, version: '3.2.0' });

    expect(result.version).toBe('3.2.0');
    expect(mockDocStore['installer_metadata/latest']?.data).toMatchObject({
      version: '3.2.0',
      promoted_by: 'user-superadmin',
      release_date: expect.any(String),
    });
  });

  it('rejects missing and soft-deleted versions', async () => {
    await expect(
      setLatestInstaller({ actor, version: '9.9.9' }),
    ).rejects.toBeInstanceOf(LatestInstallerNotFoundError);

    seedVersion('3.2.1', { deletedAt: 1234 });
    await expect(
      setLatestInstaller({ actor, version: '3.2.1' }),
    ).rejects.toBeInstanceOf(InstallerVersionDeletedError);
  });
});

describe('deleteInstaller', () => {
  it('soft-deletes when more than the minimum active versions remain', async () => {
    seedVersion('3.0.0');
    seedVersion('3.1.0');
    seedVersion('3.2.0');

    const result = await deleteInstaller({ actor, version: '3.0.0' });

    expect(result).toMatchObject({ kind: 'deleted', alreadyDeleted: false });
    expect(mockDocStore['installer_metadata/data/versions/3.0.0']?.data).toMatchObject({
      deletedBy: 'user-superadmin',
      deletedAt: expect.any(Number),
    });
  });

  it('refuses to drop below the minimum active version count', async () => {
    seedVersion('3.0.0');
    seedVersion('3.1.0');

    await expect(
      deleteInstaller({ actor, version: '3.0.0' }),
    ).rejects.toBeInstanceOf(InstallerMinVersionsViolatedError);
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it('is idempotent for already-deleted versions', async () => {
    seedVersion('3.0.0', { deletedAt: 1234 });
    seedVersion('3.1.0');
    seedVersion('3.2.0');

    const result = await deleteInstaller({ actor, version: '3.0.0' });

    expect(result).toEqual({
      kind: 'already_deleted',
      version: '3.0.0',
      deletedAt: 1234,
      alreadyDeleted: true,
    });
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it('rejects missing versions', async () => {
    await expect(
      deleteInstaller({ actor, version: '9.9.9' }),
    ).rejects.toBeInstanceOf(DeleteInstallerNotFoundError);
  });
});
