/** @jest-environment node */

/**
 * getSiteAlertRecipients — empty-recipient ADMIN_EMAIL fallback.
 *
 * Regression for the muted-machine alert leak: when a site resolves to zero
 * real recipients (e.g. the agent-default `default_site`, which a superadmin
 * manages via god-mode without being its owner or a member), the synthetic
 * ADMIN_EMAIL fallback must carry the admin's OWN muted-machines — otherwise an
 * empty list silently defeats the per-recipient mute guard in every alert
 * sender and a muted machine still emails the admin.
 */

const mockGetUserByEmail = jest.fn();
const mockSiteDocGet = jest.fn();
const mockUsersWhereGet = jest.fn();
const mockUserDocGet = jest.fn();
// Records the id passed to users.doc(...) so a regression to doc(ADMIN_EMAIL)
// instead of doc(adminUser.uid) is caught instead of silently passing.
const mockUsersDoc = jest.fn(() => ({ get: mockUserDocGet }));

const mockDb = {
  collection: (name: string) => {
    if (name === 'sites') {
      return { doc: () => ({ get: mockSiteDocGet }) };
    }
    if (name === 'users') {
      return {
        where: () => ({ get: mockUsersWhereGet }),
        doc: mockUsersDoc,
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
  getAdminAuth: () => ({ getUserByEmail: mockGetUserByEmail }),
}));

const ADMIN_EMAIL = 'admin@owlette.test';

let getSiteAlertRecipients: typeof import('@/lib/adminUtils.server').getSiteAlertRecipients;

beforeAll(async () => {
  // ADMIN_EMAIL is read at module load from ADMIN_EMAIL_DEV (NODE_ENV=test ->
  // not production), so it must be set before the module is imported.
  process.env.ADMIN_EMAIL_DEV = ADMIN_EMAIL;
  ({ getSiteAlertRecipients } = await import('@/lib/adminUtils.server'));
});

beforeEach(() => {
  // Default scenario: empty recipient set -> fallback fires.
  mockSiteDocGet.mockReset().mockResolvedValue({ data: () => ({}) }); // no owner
  mockUsersWhereGet.mockReset().mockResolvedValue({ docs: [] }); // no members
  mockUserDocGet
    .mockReset()
    .mockResolvedValue({ data: () => ({ email: ADMIN_EMAIL, preferences: { mutedMachines: ['TEC-A4D'] } }) });
  mockGetUserByEmail.mockReset().mockResolvedValue({ uid: 'admin-uid' });
  mockUsersDoc.mockClear(); // keep impl, clear recorded calls
});

describe('getSiteAlertRecipients — ADMIN_EMAIL fallback', () => {
  it("carries the admin's own muted-machines into the fallback recipient", async () => {
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    // Must read users/{auth uid}, not users/{email} — a doc(ADMIN_EMAIL)
    // regression would otherwise still pass against this mock.
    expect(mockUsersDoc).toHaveBeenCalledWith('admin-uid');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'] },
    ]);
  });

  it('fails open to empty mutes when ADMIN_EMAIL maps to no Auth user', async () => {
    mockGetUserByEmail.mockRejectedValue(new Error('auth/user-not-found'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
  });

  it('ignores a deleted admin doc and fails open (still delivers)', async () => {
    mockUserDocGet.mockResolvedValue({
      data: () => ({ deletedAt: 1700000000000, preferences: { mutedMachines: ['TEC-A4D'] } }),
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
  });

  it('does NOT hit the fallback (or read admin mutes) when a real recipient exists', async () => {
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'u1', data: () => ({ email: 'u1@owlette.test', preferences: { mutedMachines: ['OTHER-1'] } }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'u1', email: 'u1@owlette.test', ccEmails: [], mutedMachines: ['OTHER-1'] },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('fails open (delivers, no mutes) when recipient enumeration throws — even if the admin muted the machine', async () => {
    // A transient Firestore error during enumeration must NOT be treated as
    // "genuinely empty": the admin's mutes are NOT applied, so the alert is
    // delivered rather than silently suppressed.
    mockSiteDocGet.mockRejectedValue(new Error('firestore unavailable'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('fails open when the admin-doc read throws after getUserByEmail succeeds', async () => {
    // Enumeration succeeds and is genuinely empty, so the admin lookup runs;
    // getUserByEmail resolves but the users/{uid} read fails -> inner catch ->
    // empty mutes -> deliver (do not suppress on a transient admin-doc error).
    mockGetUserByEmail.mockResolvedValue({ uid: 'admin-uid' });
    mockUserDocGet.mockRejectedValue(new Error('admin doc read failed'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
  });

  it('fails open when the OWNER doc read throws (inner catch is an enumeration failure)', async () => {
    // Site has an owner but no array-contains members; the owner-doc read
    // transiently fails. The owner branch's inner catch must flag enumeration
    // as failed so the fallback does NOT apply the admin's mutes (deliver).
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockUsersWhereGet.mockResolvedValue({ docs: [] });
    mockUserDocGet.mockRejectedValue(new Error('owner read failed'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('does NOT fall back when a site MEMBER exists but opted out of this alert type', async () => {
    // A real member exists (email, not deleted) but opted out of thresholdAlerts.
    // The empty recipient set is their deliberate choice — the fallback must NOT
    // override it and spam the admin (this is the live default_site scenario).
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ email: 'member@owlette.test', preferences: { thresholdAlerts: false, mutedMachines: [] } }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('does NOT fall back when the site OWNER exists but opted out (owner branch)', async () => {
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockUsersWhereGet.mockResolvedValue({ docs: [] }); // no array-contains members
    mockUserDocGet.mockResolvedValue({ data: () => ({ email: 'owner@owlette.test', preferences: { thresholdAlerts: false } }) });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('treats a member with NO email as orphan -> fallback still fires (honors admin mutes)', async () => {
    // A member doc with no email can't receive alerts, so it must NOT count as a
    // real user — the site is still orphan and the safety-net fallback must fire.
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ preferences: { mutedMachines: [] } }) }], // no email
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'] },
    ]);
  });

  it('treats a DELETED member as orphan -> fallback still fires', async () => {
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ email: 'gone@owlette.test', deletedAt: 1700000000000, preferences: {} }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'] },
    ]);
  });
});
