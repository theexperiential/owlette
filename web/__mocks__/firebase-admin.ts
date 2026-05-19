/**
 * Firebase Admin SDK Mock for API Route Testing
 *
 * Mocks getAdminDb(), getAdminAuth(), and getAdminStorage() from @/lib/firebase-admin.
 * Each test should configure mock return values via the exported mock functions.
 *
 * Usage in tests:
 *   import { mockDbGet, mockDbSet, mockDbUpdate, resetAdminMocks } from '@/__mocks__/firebase-admin';
 *   beforeEach(() => resetAdminMocks());
 *   mockDbGet.mockResolvedValueOnce({ exists: true, data: () => ({...}) });
 */

// --- Firestore Mocks ---

export const mockDbGet = jest.fn().mockResolvedValue({ exists: false, data: () => null, id: 'mock' });
export const mockDbSet = jest.fn().mockResolvedValue(undefined);
export const mockDbUpdate = jest.fn().mockResolvedValue(undefined);
export const mockDbDelete = jest.fn().mockResolvedValue(undefined);
export const mockRunTransaction = jest.fn(async (fn: (tx: unknown) => unknown) => {
  // Simulate transaction by passing a mock transaction object
  const mockTransaction = {
    get: mockDbGet,
    set: mockDbSet,
    update: mockDbUpdate,
    delete: mockDbDelete,
  };
  return fn(mockTransaction);
});

// Chainable collection/doc pattern
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

// --- Auth Mocks ---

export const mockVerifyIdToken = jest.fn().mockResolvedValue({ uid: 'test-uid' });

const mockAuth = {
  verifyIdToken: mockVerifyIdToken,
  createCustomToken: jest.fn().mockResolvedValue('mock-custom-token'),
};

// --- Storage Mocks ---

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

// --- Exported Getters (match firebase-admin.ts exports) ---

export const getAdminDb = jest.fn(() => mockDb);
export const getAdminAuth = jest.fn(() => mockAuth);
export const getAdminStorage = jest.fn(() => mockStorage);

// --- Reset Helper ---

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

// Default export to match `import admin from 'firebase-admin'`
export default {
  apps: [{}], // Pretend SDK is initialized
  auth: () => mockAuth,
  firestore: () => mockDb,
  storage: () => mockStorage,
};
