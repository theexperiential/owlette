/**
 * Firebase Mock for Testing
 *
 * Provides mock implementations of Firebase services for unit testing.
 * Use these mocks in your tests to avoid real Firebase calls.
 */

// Mock Firestore functions
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

// Mock Auth functions
export const mockSignInWithEmailAndPassword = jest.fn();
export const mockCreateUserWithEmailAndPassword = jest.fn();
export const mockSignOut = jest.fn();
export const mockOnAuthStateChanged = jest.fn((_auth, _callback) => {
  // Return unsubscribe function
  return jest.fn();
});
export const mockSignInWithPopup = jest.fn();

// Mock Firebase services
export const mockAuth = {
  currentUser: null,
  signInWithEmailAndPassword: mockSignInWithEmailAndPassword,
  signOut: mockSignOut,
};

export const mockDb = {
  collection: mockCollection,
  doc: mockDoc,
};

// Reset all mocks
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

// Helper to create a mock Firestore document snapshot
export const createMockDocSnapshot = (data: any, exists = true) => ({
  exists: () => exists,
  data: () => data,
  id: 'mock-doc-id',
  ref: { id: 'mock-doc-id' },
});

// Helper to create a mock Firestore query snapshot
export const createMockQuerySnapshot = (docs: any[]) => ({
  docs: docs.map((data, index) => ({
    exists: () => true,
    data: () => data,
    id: `mock-doc-${index}`,
    ref: { id: `mock-doc-${index}` },
  })),
  empty: docs.length === 0,
  size: docs.length,
  forEach: (callback: (doc: any) => void) => {
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

// Helper to create a mock Firebase user
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
