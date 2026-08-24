/**
 * Mocks getAdminDb/getAdminAuth/getAdminStorage from @/lib/firebase-admin.
 * Tests configure return values through the exported mock functions:
 *
 *   import { mockDbGet, resetAdminMocks } from '@/__mocks__/firebase-admin';
 *   beforeEach(() => resetAdminMocks());
 *   mockDbGet.mockResolvedValueOnce({ exists: true, data: () => ({...}) });
 */

export const mockDbGet = jest.fn().mockResolvedValue({ exists: false, data: () => null, id: 'mock' });
export const mockDbSet = jest.fn().mockResolvedValue(undefined);
export const mockDbUpdate = jest.fn().mockResolvedValue(undefined);
export const mockDbDelete = jest.fn().mockResolvedValue(undefined);
export const mockRunTransaction = jest.fn(async (fn: (tx: unknown) => unknown) => {
  const mockTransaction = {
    get: mockDbGet,
    set: mockDbSet,
    update: mockDbUpdate,
    delete: mockDbDelete,
  };
  return fn(mockTransaction);
});

const createDocRef = (docId?: string) => ({
  get: mockDbGet,
  set: mockDbSet,
  update: mockDbUpdate,
  delete: mockDbDelete,
  id: docId || 'mock-doc',
  collection: (subCol: string) => createCollectionRef(subCol),
});

const createCollectionRef = (_colId?: string) => ({
  doc: (docId?: string) => createDocRef(docId),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  get: mockDbGet,
});

const mockDb = {
  collection: (col: string) => createCollectionRef(col),
  runTransaction: mockRunTransaction,
};

export const mockVerifyIdToken = jest.fn().mockResolvedValue({ uid: 'test-uid' });

const mockAuth = {
  verifyIdToken: mockVerifyIdToken,
  createCustomToken: jest.fn().mockResolvedValue('mock-custom-token'),
};

export const mockGetSignedUrl = jest.fn().mockResolvedValue(['https://storage.example.com/signed-url']);
export const mockFileExists = jest.fn().mockResolvedValue([true]);
export const mockGetMetadata = jest.fn().mockResolvedValue([{ size: '1024' }]);
export const mockFileSave = jest.fn().mockResolvedValue(undefined);

const mockStorage = {
  bucket: () => ({
    file: (_path: string) => ({
      getSignedUrl: mockGetSignedUrl,
      exists: mockFileExists,
      getMetadata: mockGetMetadata,
      save: mockFileSave,
    }),
  }),
};

// Getters, matching the firebase-admin.ts exports.
export const getAdminDb = jest.fn(() => mockDb);
export const getAdminAuth = jest.fn(() => mockAuth);
export const getAdminStorage = jest.fn(() => mockStorage);

export const resetAdminMocks = () => {
  mockDbGet.mockReset().mockResolvedValue({ exists: false, data: () => null, id: 'mock' });
  mockDbSet.mockReset().mockResolvedValue(undefined);
  mockDbUpdate.mockReset().mockResolvedValue(undefined);
  mockDbDelete.mockReset().mockResolvedValue(undefined);
  mockRunTransaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const mockTransaction = {
      get: mockDbGet,
      set: mockDbSet,
      update: mockDbUpdate,
      delete: mockDbDelete,
    };
    return fn(mockTransaction);
  });
  mockVerifyIdToken.mockReset().mockResolvedValue({ uid: 'test-uid' });
  mockGetSignedUrl.mockReset().mockResolvedValue(['https://storage.example.com/signed-url']);
  mockFileExists.mockReset().mockResolvedValue([true]);
  mockGetMetadata.mockReset().mockResolvedValue([{ size: '1024' }]);
  mockFileSave.mockReset().mockResolvedValue(undefined);
};

