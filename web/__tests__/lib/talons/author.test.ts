/** @jest-environment node */

/**
 * Unit tests for the talon author pre-flight.
 *
 * This module is the one place that decides whether an unattended run has hit
 * something a retry could fix. Everything it throws as a `TalonAuthorError`
 * switches the talon off on the first occurrence, so the FATAL/TRANSIENT split
 * below is the contract worth pinning: a deterministic refusal is fatal, and an
 * unreachable database — which says nothing at all about the author — is not.
 *
 * `hoot-utils` is mocked at its boundary, including a stand-in `SiteAccessError`
 * whose shape mirrors the real class (`name` + `code`), because the real module
 * pulls in the whole tool registry to be loaded.
 */

const mockVerifyUserSiteAccess = jest.fn();
const mockResolveLlmConfig = jest.fn();
const mockAssertLlmKeyAvailable = jest.fn();

jest.mock('@/lib/hoot-utils.server', () => {
  class SiteAccessError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'SiteAccessError';
      this.code = code;
    }
  }
  return {
    __esModule: true,
    SiteAccessError,
    verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
    resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
    assertLlmKeyAvailable: (...args: unknown[]) => mockAssertLlmKeyAvailable(...args),
  };
});

import type { Firestore } from 'firebase-admin/firestore';
import {
  TalonAuthorError,
  assertTalonAuthorLlmKey,
  resolveTalonAuthor,
  resolveTalonAuthorLlmConfig,
} from '@/lib/talons/author.server';
import type { StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc } from '@/lib/talons/types';

const { SiteAccessError } = jest.requireMock('@/lib/hoot-utils.server') as {
  SiteAccessError: new (code: string, message: string) => Error;
};

const SITE = 'site-a';
const db = {} as Firestore;

const ACCESS = {
  role: 'admin',
  isSuperadmin: false,
  isSiteAdmin: true,
  isSiteOwner: false,
};

function talonFixture(overrides: Partial<TalonDoc> = {}): StoredTalon {
  const doc: TalonDoc = {
    schemaVersion: 1,
    name: 'lobby wall check',
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'cortex', directive: 'look' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: new Date(),
    updatedAt: new Date(),
    consecutiveFailures: 0,
    ...overrides,
  };
  return { id: 't1', ...doc };
}

/** The reason on a rejection, or the error itself when it was not classified. */
async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'did not throw',
    (error: unknown) => (error instanceof TalonAuthorError ? error.reason : error),
  );
}

beforeEach(() => {
  mockVerifyUserSiteAccess.mockReset();
  mockResolveLlmConfig.mockReset();
  mockAssertLlmKeyAvailable.mockReset();
  mockVerifyUserSiteAccess.mockResolvedValue(ACCESS);
  mockAssertLlmKeyAvailable.mockResolvedValue(undefined);
  mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-test' });
});

describe('resolveTalonAuthor', () => {
  it('returns the author uid and the access they hold right now', async () => {
    await expect(resolveTalonAuthor(db, SITE, talonFixture())).resolves.toEqual({
      userId: 'admin-uid',
      access: ACCESS,
    });
    expect(mockVerifyUserSiteAccess).toHaveBeenCalledWith(db, 'admin-uid', SITE);
  });

  it.each([
    ['system:talon_runner', 'a system actor'],
    ['', 'no author at all'],
  ])('refuses %s without even looking up access', async (createdBy) => {
    await expect(reasonOf(resolveTalonAuthor(db, SITE, talonFixture({ createdBy })))).resolves.toBe(
      'creator_not_a_user',
    );
    expect(mockVerifyUserSiteAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['user_not_found', 'creator_deleted'],
    ['user_deleted', 'creator_deleted'],
    ['no_site_access', 'creator_access_revoked'],
  ])('maps the %s refusal onto %s', async (code, reason) => {
    mockVerifyUserSiteAccess.mockRejectedValue(new SiteAccessError(code, 'nope'));

    await expect(reasonOf(resolveTalonAuthor(db, SITE, talonFixture()))).resolves.toBe(reason);
  });

  it('does not classify a missing site as an author problem', async () => {
    // The site being gone is not the author's fault, and a talon in a
    // collection that no longer exists has bigger problems than its flag.
    const thrown = new SiteAccessError('site_not_found', 'Site not found');
    mockVerifyUserSiteAccess.mockRejectedValue(thrown);

    await expect(reasonOf(resolveTalonAuthor(db, SITE, talonFixture()))).resolves.toBe(thrown);
  });

  it('lets a transient read failure through unclassified', async () => {
    const thrown = new Error('DEADLINE_EXCEEDED');
    mockVerifyUserSiteAccess.mockRejectedValue(thrown);

    // Not a TalonAuthorError — so nothing downstream disables the talon over a
    // database that happened to be unreachable for one firing.
    await expect(reasonOf(resolveTalonAuthor(db, SITE, talonFixture()))).resolves.toBe(thrown);
  });
});

describe('the llm key pre-flight', () => {
  it('hands back the config the author owns', async () => {
    await expect(resolveTalonAuthorLlmConfig(db, 'admin-uid')).resolves.toEqual({
      provider: 'anthropic',
      apiKey: 'sk-test',
    });
    expect(mockResolveLlmConfig).toHaveBeenCalledWith(db, 'admin-uid');
  });

  it.each([
    ['no key saved', 'No LLM API key configured. Add one in Account Settings → hoot.'],
    ['an undecryptable key', 'Failed to decrypt the stored LLM API key.'],
  ])('treats %s as unrecoverable', async (_label, message) => {
    mockResolveLlmConfig.mockRejectedValue(new Error(message));

    await expect(reasonOf(resolveTalonAuthorLlmConfig(db, 'admin-uid'))).resolves.toBe(
      'creator_missing_llm_key',
    );
  });

  it('asserts the key without ever receiving it', async () => {
    await expect(assertTalonAuthorLlmKey(db, 'admin-uid')).resolves.toBeUndefined();
    // The void-returning helper, not the one that returns the decrypted key.
    expect(mockAssertLlmKeyAvailable).toHaveBeenCalledWith(db, 'admin-uid');
    expect(mockResolveLlmConfig).not.toHaveBeenCalled();
  });

  it('classifies a failed assertion the same way', async () => {
    mockAssertLlmKeyAvailable.mockRejectedValue(new Error('No LLM API key configured.'));

    await expect(reasonOf(assertTalonAuthorLlmKey(db, 'admin-uid'))).resolves.toBe(
      'creator_missing_llm_key',
    );
  });
});
