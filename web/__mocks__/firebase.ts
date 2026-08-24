/** Mock Firebase services, so unit tests make no real Firebase calls. */
export const mockCollection = jest.fn();
export const mockDoc = jest.fn();
export const mockGetDoc = jest.fn();
export const mockGetDocs = jest.fn();
export const mockSetDoc = jest.fn();
export const mockUpdateDoc = jest.fn();
export const mockDeleteDoc = jest.fn();
export const mockOnSnapshot = jest.fn();
export const mockQuery = jest.fn();
export const mockWhere = jest.fn();
export const mockOrderBy = jest.fn();
export const mockLimit = jest.fn();

export const mockSignInWithEmailAndPassword = jest.fn();
export const mockCreateUserWithEmailAndPassword = jest.fn();
export const mockSignOut = jest.fn();
export const mockOnAuthStateChanged = jest.fn((_auth, _callback) => {
  return jest.fn();
});
export const mockSignInWithPopup = jest.fn();

export const mockAuth = {
  currentUser: null,
  signInWithEmailAndPassword: mockSignInWithEmailAndPassword,
  signOut: mockSignOut,
};

export const mockDb = {
  collection: mockCollection,
  doc: mockDoc,
};

export const resetAllMocks = () => {
  mockCollection.mockClear();
  mockDoc.mockClear();
  mockGetDoc.mockClear();
  mockGetDocs.mockClear();
  mockSetDoc.mockClear();
  mockUpdateDoc.mockClear();
  mockDeleteDoc.mockClear();
  mockOnSnapshot.mockClear();
  mockQuery.mockClear();
  mockWhere.mockClear();
  mockOrderBy.mockClear();
  mockLimit.mockClear();
  mockSignInWithEmailAndPassword.mockClear();
  mockCreateUserWithEmailAndPassword.mockClear();
  mockSignOut.mockClear();
  mockOnAuthStateChanged.mockClear();
  mockSignInWithPopup.mockClear();
};

export const createMockDocSnapshot = (data: unknown, exists = true) => ({
  exists: () => exists,
  data: () => data,
  id: 'mock-doc-id',
  ref: { id: 'mock-doc-id' },
});

export const createMockQuerySnapshot = (docs: unknown[]) => ({
  docs: docs.map((data, index) => ({
    exists: () => true,
    data: () => data,
    id: `mock-doc-${index}`,
    ref: { id: `mock-doc-${index}` },
  })),
  empty: docs.length === 0,
  size: docs.length,
  forEach: (callback: (doc: unknown) => void) => {
    docs.forEach((data, index) => {
      callback({
        exists: () => true,
        data: () => data,
        id: `mock-doc-${index}`,
        ref: { id: `mock-doc-${index}` },
      });
    });
  },
});

export const createMockUser = (uid = 'test-uid', email = 'test@example.com') => ({
  uid,
  email,
  displayName: 'Test User',
  emailVerified: true,
  isAnonymous: false,
  metadata: {},
  providerData: [],
  refreshToken: 'mock-refresh-token',
  tenantId: null,
  delete: jest.fn(),
  getIdToken: jest.fn().mockResolvedValue('mock-id-token'),
  getIdTokenResult: jest.fn(),
  reload: jest.fn(),
  toJSON: jest.fn(),
  phoneNumber: null,
  photoURL: null,
  providerId: 'firebase',
});
