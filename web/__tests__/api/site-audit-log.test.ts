/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
} from './helpers/firestore-mock';
import {
  canonicalJson,
  computeChainHash,
} from '@/lib/auditLogVerify';

const mockRequireSiteAuthAndScope = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    private readonly ms: number;

    constructor(ms: number) {
      this.ms = ms;
    }

    static fromDate(date: Date): MockTimestamp {
      return new MockTimestamp(date.getTime());
    }

    toDate(): Date {
      return new Date(this.ms);
    }

    toMillis(): number {
      return this.ms;
    }
  }

  return {
    Timestamp: MockTimestamp,
    FieldValue: {
      serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    },
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('@/app/api/_shared', () => ({
  applyAuthDeprecations: (response: Response) => response,
  requireSiteAuthAndScope: (...args: unknown[]) => mockRequireSiteAuthAndScope(...args),
}));

import { GET as auditListGET } from '@/app/api/sites/[siteId]/audit-log/route';
import { GET as auditDetailGET } from '@/app/api/sites/[siteId]/audit-log/[recordHash]/route';

const SITE = 'site-alpha';

function routeContext(siteId = SITE) {
  return { params: Promise.resolve({ siteId }) };
}

function auditDoc(id: string, kind = 'api_key_used') {
  return {
    id,
    data: {
      event: {
        kind,
        siteId: SITE,
        actor: 'apiKey:key-1',
        occurredAt: 1_700_000_000_000,
        attributes: { endpoint: '/api/sites/site-alpha/machines' },
      },
      recordedAt: 1_700_000_000_001,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSiteAuthAndScope.mockResolvedValue({
    ok: true,
    userId: 'admin-uid',
    auth: { userId: 'admin-uid', keyContext: null },
    scopeCheck: { isLegacy: false },
  });
  mocks.get.mockResolvedValue(docSnapshot('any', {}));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('GET /api/sites/{siteId}/audit-log', () => {
  it('uses the last returned record as the next page token', async () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        auditDoc(first),
        auditDoc(second),
      ]),
    );

    const res = await auditListGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/audit-log?page_size=1`),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].hash).toBe(first);
    expect(body.next_page_token).toBe(first);
    expect(body.nextPageToken).toBe(first);
  });

  it('accepts legacy limit/cursor aliases while emitting canonical fields', async () => {
    const cursor = 'c'.repeat(64);
    const first = 'd'.repeat(64);
    mocks.get.mockResolvedValueOnce(docSnapshot(cursor, { recordedAt: 1 }));
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([auditDoc(first)]));

    const res = await auditListGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/audit-log?limit=10&cursor=${cursor}`),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.startAfter).toHaveBeenCalled();
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
  });

  it('pushes kind and actor filters through the collected page', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        auditDoc('e'.repeat(64), 'api_key_used'),
        {
          ...auditDoc('f'.repeat(64), 'roost_mutated'),
          data: {
            ...auditDoc('f'.repeat(64), 'roost_mutated').data,
            event: {
              ...auditDoc('f'.repeat(64), 'roost_mutated').data.event,
              actor: 'user:other',
            },
          },
        },
      ]),
    );

    const res = await auditListGET(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/audit-log?kind=api_key_used&actor=apiKey:key-1`,
      ),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.records.map((record: { hash: string }) => record.hash)).toEqual(['e'.repeat(64)]);
  });
});

describe('GET /api/sites/{siteId}/audit-log/{recordHash}', () => {
  it('marks non-genesis records invalid when the predecessor is missing', async () => {
    const previousHash = '1'.repeat(64);
    const event = {
      kind: 'api_key_used',
      siteId: SITE,
      actor: 'apiKey:key-1',
      occurredAt: 1_700_000_000_000,
      attributes: { endpoint: '/api/sites/site-alpha/machines' },
    };
    const recordedAt = 1_700_000_000_001;
    const hash = computeChainHash(previousHash, recordedAt, canonicalJson(event));

    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(hash, {
          event,
          recordedAt,
          previousHash,
          hash,
        }),
      )
      .mockResolvedValueOnce(docSnapshot(previousHash, null));

    const res = await auditDetailGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/audit-log/${hash}`),
      { params: Promise.resolve({ siteId: SITE, recordHash: hash }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.verification).toMatchObject({
      ok: false,
      hashValid: true,
      linkageValid: false,
      isGenesis: false,
      predecessorPresent: false,
      reason: 'predecessor_missing',
    });
  });
});
