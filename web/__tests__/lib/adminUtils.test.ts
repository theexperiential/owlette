/** @jest-environment node */

/**
 * getSiteAlertRecipients — empty-recipient ADMIN_EMAIL fallback.
 *
 * Regression for the muted-machine alert leak: when a site has zero real
 * recipients (e.g. `default_site`, managed by a superadmin who is neither owner
 * nor member), the synthetic ADMIN_EMAIL fallback must carry the admin's OWN
 * muted machines — an empty list defeats the per-recipient mute guard in every
 * sender and a muted machine emails the admin anyway.
 */

const mockGetUserByEmail = jest.fn();
const mockSiteDocGet = jest.fn();
const mockUsersWhereGet = jest.fn();
const mockUserDocGet = jest.fn();
// Records the id passed to users.doc(...), so a regression to doc(ADMIN_EMAIL)
// instead of doc(adminUser.uid) fails instead of silently passing.
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
  // ADMIN_EMAIL is read at module load from ADMIN_EMAIL_DEV — set it first.
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
    // users/{auth uid}, not users/{email}: doc(ADMIN_EMAIL) must not pass here.
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
    // A transient enumeration error is not "genuinely empty": mutes are not
    // applied, so the alert is delivered rather than suppressed.
    mockSiteDocGet.mockRejectedValue(new Error('firestore unavailable'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('fails open when the admin-doc read throws after getUserByEmail succeeds', async () => {
    // Genuinely empty -> admin lookup runs -> users/{uid} read fails -> inner
    // catch -> empty mutes -> deliver.
    mockGetUserByEmail.mockResolvedValue({ uid: 'admin-uid' });
    mockUserDocGet.mockRejectedValue(new Error('admin doc read failed'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
  });

  it('fails open when the OWNER doc read throws (inner catch is an enumeration failure)', async () => {
    // Owner but no array-contains members, and the owner-doc read fails: the
    // owner branch must flag enumeration failed so mutes are not applied.
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
    // A real member opted out of thresholdAlerts: the empty set is deliberate and
    // the fallback must not override it (the live default_site scenario).
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
    // A member with no email cannot receive alerts, so the site is still orphan
    // and the fallback must fire.
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
