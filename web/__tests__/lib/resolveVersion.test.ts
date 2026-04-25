/** @jest-environment node */

import { mocks, mockDbFactory, docSnapshot, querySnapshot } from '../api/helpers/firestore-mock';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
}));

import {
  resolveVersion,
  ResolveVersionError,
  VersionNotFoundError,
  VersionRefMalformedError,
} from '@/lib/resolveVersion';

const ROOST = 'rst_test_0000000001';
const SITE = 'site-alpha';

beforeEach(() => {
  jest.clearAllMocks();
  mocks.get.mockReset();
  mocks.collectionGet.mockReset();
});

/* ========================================================================== */
/*  malformed refs (no IO — fail fast)                                        */
/* ========================================================================== */

describe('resolveVersion — malformed refs', () => {
  it('empty string → VersionRefMalformedError', async () => {
    await expect(resolveVersion({ roostId: ROOST, siteId: SITE, ref: '' })).rejects.toBeInstanceOf(
      VersionRefMalformedError,
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('whitespace-only → VersionRefMalformedError', async () => {
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: '   \n\t  ' }),
    ).rejects.toBeInstanceOf(VersionRefMalformedError);
  });

  it('zero number → malformed (resolver requires positive int)', async () => {
    await expect(resolveVersion({ roostId: ROOST, siteId: SITE, ref: '0' })).rejects.toBeInstanceOf(
      VersionRefMalformedError,
    );
  });

  it('negative number → malformed', async () => {
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: '-3' }),
    ).rejects.toBeInstanceOf(VersionRefMalformedError);
  });

  it('decimal → malformed (parseInt would silently coerce; we reject)', async () => {
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: '3.0' }),
    ).rejects.toBeInstanceOf(VersionRefMalformedError);
  });

  it('alphanumeric like "3abc" → malformed', async () => {
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: '3abc' }),
    ).rejects.toBeInstanceOf(VersionRefMalformedError);
  });

  it('error message includes the malformed input + the accepted forms', async () => {
    try {
      await resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'banana' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionRefMalformedError);
      expect((err as Error).message).toContain('banana');
      expect((err as Error).message).toMatch(/positive integer|vrs_|current|previous|first/);
    }
  });

  it('error code is "version_ref_malformed"', async () => {
    try {
      await resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'gibberish' });
    } catch (err) {
      expect((err as ResolveVersionError).code).toBe('version_ref_malformed');
      expect((err as ResolveVersionError).status).toBe(400);
    }
  });
});

/* ========================================================================== */
/*  number forms (3 / #3 / v3 / V3) — all map to lookupByNumber               */
/* ========================================================================== */

describe('resolveVersion — number forms', () => {
  it.each([
    ['3', 3],
    ['#3', 3],
    ['v3', 3],
    ['V3', 3],
    ['12', 12],
    ['#42', 42],
  ])('"%s" looks up versionNumber=%i', async (ref, expectedNumber) => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'vrs_for_number_test_xx',
          data: { versionId: 'vrs_for_number_test_xx', versionNumber: expectedNumber },
        },
      ]),
    );
    const result = await resolveVersion({ roostId: ROOST, siteId: SITE, ref });
    expect(result.versionNumber).toBe(expectedNumber);
    expect(result.versionId).toBe('vrs_for_number_test_xx');
    // confirm the where('versionNumber', '==', N).limit(1).get() chain ran
    expect(mocks.where).toHaveBeenCalledWith('versionNumber', '==', expectedNumber);
    expect(mocks.limit).toHaveBeenCalledWith(1);
  });

  it('non-existent versionNumber → VersionNotFoundError', async () => {
    mocks.collectionGet.mockResolvedValueOnce({ empty: true, docs: [] } as never);
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: '99' }),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });
});

/* ========================================================================== */
/*  stable id form (vrs_*) — direct lookup                                    */
/* ========================================================================== */

describe('resolveVersion — stable id form', () => {
  it('vrs_* prefix → lookupById on /versions/{id}', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('vrs_abc123', { versionId: 'vrs_abc123', versionNumber: 7 }),
    );
    const result = await resolveVersion({
      roostId: ROOST,
      siteId: SITE,
      ref: 'vrs_abc123',
    });
    expect(result.versionId).toBe('vrs_abc123');
    expect(result.versionNumber).toBe(7);
  });

  it('non-existent vrs_id → VersionNotFoundError', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('vrs_does_not_exist', null));
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'vrs_does_not_exist' }),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it('VersionNotFoundError carries code "version_not_found" + status 404', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('vrs_missing', null));
    try {
      await resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'vrs_missing' });
    } catch (err) {
      expect((err as ResolveVersionError).code).toBe('version_not_found');
      expect((err as ResolveVersionError).status).toBe(404);
    }
  });
});

/* ========================================================================== */
/*  alias forms (current / previous / first)                                  */
/* ========================================================================== */

describe('resolveVersion — alias forms', () => {
  it('"current" reads roost.currentVersionId, then looks up that version', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(ROOST, {
          currentVersionId: 'vrs_current_001',
          previousVersionId: 'vrs_previous_001',
        }),
      )
      .mockResolvedValueOnce(
        docSnapshot('vrs_current_001', { versionId: 'vrs_current_001', versionNumber: 5 }),
      );
    const result = await resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'current' });
    expect(result.versionId).toBe('vrs_current_001');
    expect(result.versionNumber).toBe(5);
  });

  it('"previous" reads roost.previousVersionId, then looks up', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(ROOST, {
          currentVersionId: 'vrs_current_001',
          previousVersionId: 'vrs_previous_001',
        }),
      )
      .mockResolvedValueOnce(
        docSnapshot('vrs_previous_001', { versionId: 'vrs_previous_001', versionNumber: 4 }),
      );
    const result = await resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'previous' });
    expect(result.versionId).toBe('vrs_previous_001');
    expect(result.versionNumber).toBe(4);
  });

  it('"first" looks up versionNumber=1 directly (skips roost-doc read of currentVersionId)', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, { versionCounter: 7 }));
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([{ id: 'vrs_v1_id', data: { versionId: 'vrs_v1_id', versionNumber: 1 } }]),
    );
    const result = await resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'first' });
    expect(result.versionNumber).toBe(1);
    expect(result.versionId).toBe('vrs_v1_id');
    expect(mocks.where).toHaveBeenCalledWith('versionNumber', '==', 1);
  });

  it('"current" on a roost with no currentVersionId → VersionNotFoundError', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, { versionCounter: 0 }));
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'current' }),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it('"previous" on a roost with only one publish → VersionNotFoundError', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, { currentVersionId: 'vrs_only_publish', previousVersionId: null }),
    );
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'previous' }),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it('alias on a non-existent roost → VersionNotFoundError', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, null));
    await expect(
      resolveVersion({ roostId: ROOST, siteId: SITE, ref: 'current' }),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });
});

/* ========================================================================== */
/*  whitespace tolerance                                                      */
/* ========================================================================== */

describe('resolveVersion — whitespace tolerance', () => {
  it('trims surrounding whitespace from refs (shell-paste tolerance)', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        { id: 'vrs_trim_test', data: { versionId: 'vrs_trim_test', versionNumber: 3 } },
      ]),
    );
    const result = await resolveVersion({
      roostId: ROOST,
      siteId: SITE,
      ref: '  v3\n',
    });
    expect(result.versionNumber).toBe(3);
  });
});
