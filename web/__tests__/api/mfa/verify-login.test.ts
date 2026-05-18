/** @jest-environment node */

/**
 * Concurrency tests for `/api/mfa/verify-login` backup-code path.
 *
 * Wave 1-3 round-1 audit flagged a "two parallel logins with the same
 * backup code both succeed" race. The fix routes backup-code consumption
 * through `db.runTransaction`, which Firestore re-runs on contention.
 *
 * The CAS-style mock below simulates that contention: both transactions
 * read the same backup-code list, but only the first commit "wins" and
 * the second one re-runs against the post-commit state (where the code
 * is no longer present) and returns `no_match`.
 */

const mockVerifyTOTP = jest.fn();
const mockVerifyBackupCode = jest.fn();
const mockDecrypt = jest.fn();
const mockIsEncryptionConfigured = jest.fn().mockReturnValue(true);
const mockRequireSessionUser = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiAuthError,
    requireSessionUser: (...a: unknown[]) => mockRequireSessionUser(...a),
  };
});

jest.mock('@/lib/totp', () => ({
  verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
  verifyBackupCode: (...a: unknown[]) => mockVerifyBackupCode(...a),
}));

jest.mock('@/lib/encryption.server', () => ({
  decrypt: (...a: unknown[]) => mockDecrypt(...a),
  isEncryptionConfigured: () => mockIsEncryptionConfigured(),
}));

jest.mock('@/lib/sessionManager.server', () => ({
  markSessionMfaVerified: (...a: unknown[]) =>
    mockMarkSessionMfaVerified(...a),
}));

/**
 * Shared mutable doc state. Both transactions read+write this; the
 * runTransaction simulator below applies optimistic concurrency control
 * by tracking the "version" of the doc at read time and rejecting writes
 * whose pre-image is stale.
 *
 * NOTE: a real Firestore txn would AUTO-RETRY internally on contention.
 * The route's only contract is that ONE call succeeds and ONE fails,
 * which is what we assert at the end. To honour the auto-retry contract
 * the simulator below re-invokes the callback on contention with the
 * latest snapshot, so the losing call sees an empty backupCodes list
 * the second time around and returns `no_match`.
 */
interface DocState {
  version: number;
  exists: boolean;
  data: Record<string, unknown>;
}

let docState: DocState;
let txOpsLog: Array<{ action: 'read' | 'update'; version: number }>;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: docState.exists,
          data: () => docState.data,
        }),
      }),
    }),
    runTransaction: async <T>(
      cb: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      // Simulate Firestore's optimistic-CAS retry: run the callback,
      // and if its "read version" was stale at commit time, retry once.
      // Two passes max — enough for the parallel-collision case.
      for (let attempt = 0; attempt < 2; attempt++) {
        const readVersion = docState.version;
        const snapshot = {
          exists: docState.exists,
          data: () => ({ ...docState.data }),
        };
        const pendingUpdates: Record<string, unknown>[] = [];
        const tx = {
          get: async () => {
            txOpsLog.push({ action: 'read', version: readVersion });
            return snapshot;
          },
          update: (_ref: unknown, payload: Record<string, unknown>) => {
            pendingUpdates.push(payload);
            txOpsLog.push({ action: 'update', version: readVersion });
          },
        };
        const result = await cb(tx);
        // Apply pending updates only if the doc version hasn't moved
        // since this transaction started.
        if (readVersion === docState.version) {
          for (const payload of pendingUpdates) {
            docState.data = { ...docState.data, ...payload };
          }
          if (pendingUpdates.length > 0) {
            docState.version++;
          }
          return result;
        }
        // Stale — retry once with the new state.
      }
      throw new Error('transaction failed after retries');
    },
  }),
}));

import { POST } from '@/app/api/mfa/verify-login/route';
import { createMockRequest } from '../helpers/utils';

beforeEach(() => {
  jest.clearAllMocks();
  // Reset shared doc state. Two backup codes, both valid.
  docState = {
    version: 0,
    exists: true,
    data: {
      mfaEnrolled: true,
      backupCodes: ['hash-bk-1', 'hash-bk-2'],
    },
  };
  txOpsLog = [];

  mockRequireSessionUser.mockResolvedValue('user-1');
  mockVerifyTOTP.mockReturnValue(false);
  // Only match hash-bk-1 (the code under contention).
  mockVerifyBackupCode.mockImplementation(
    (_code: string, hash: string) => hash === 'hash-bk-1',
  );
});

function verifyReq() {
  return createMockRequest('http://localhost/api/mfa/verify-login', {
    method: 'POST',
    body: {
      userId: 'user-1',
      code: 'AAAA-BBBB',
      isBackupCode: true,
    },
  });
}

describe('POST /api/mfa/verify-login — backup code single-use under concurrency', () => {
  it('two parallel calls with the same backup code: exactly one succeeds, one fails', async () => {
    const [resA, resB] = await Promise.all([
      POST(verifyReq()),
      POST(verifyReq()),
    ]);

    const codes: number[] = [resA.status, resB.status];
    // Exactly one 200 and one 400 (mismatch) — the second call to retry
    // sees backupCodes containing only hash-bk-2, which doesn't match.
    expect(codes.filter((c) => c === 200).length).toBe(1);
    expect(codes.filter((c) => c === 400).length).toBe(1);

    // The successful call consumed hash-bk-1 — only hash-bk-2 should remain.
    expect(docState.data.backupCodes).toEqual(['hash-bk-2']);
  });

  it('a single sequential call still consumes correctly', async () => {
    // Control: serial behaviour.
    const r1 = await POST(verifyReq());
    expect(r1.status).toBe(200);
    expect(docState.data.backupCodes).toEqual(['hash-bk-2']);

    // Replay should fail since the code is now consumed.
    const r2 = await POST(verifyReq());
    expect(r2.status).toBe(400);
    expect(docState.data.backupCodes).toEqual(['hash-bk-2']);
  });
});
