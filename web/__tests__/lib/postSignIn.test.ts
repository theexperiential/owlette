/**
 * Post-sign-in landing resolution (lib/postSignIn).
 *
 * This exists because signing in client-side does not make the user
 * authenticated server-side: AuthContext mints the __session cookie from
 * onAuthStateChanged without awaiting it. Navigating inside that window makes
 * proxy.ts bounce to /login?redirect=<path>, which reads to the user as a
 * sign-in that silently failed — the exact symptom reported against /register.
 *
 * Every test passes settleMs: 0 so the suite is not paying the real 500ms
 * settle. The retry backoff is left real; the whole loop is under a second.
 */
import { resolvePostSignInPath } from '@/lib/postSignIn';

const mockFetch = (responses: Array<{ ok: boolean; body?: unknown }>) => {
  const fn = jest.fn();
  responses.forEach(({ ok, body }) => {
    fn.mockResolvedValueOnce({ ok, json: async () => body });
  });
  // Anything past the scripted responses keeps returning the last shape.
  fn.mockResolvedValue({
    ok: responses[responses.length - 1]?.ok ?? false,
    json: async () => responses[responses.length - 1]?.body ?? {},
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
};

describe('resolvePostSignInPath', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the target once the session is authenticated', async () => {
    mockFetch([{ ok: true, body: { authenticated: true } }]);

    await expect(resolvePostSignInPath('/dashboard', 0)).resolves.toBe('/dashboard');
  });

  it('routes to the MFA challenge when the session reports it pending', async () => {
    mockFetch([
      { ok: true, body: { authenticated: true, mfaRequired: true, mfaVerified: false } },
    ]);

    await expect(resolvePostSignInPath('/roosts', 0)).resolves.toBe(
      '/verify-2fa?redirect=%2Froosts',
    );
  });

  it('does not challenge a session that has already satisfied MFA', async () => {
    mockFetch([
      { ok: true, body: { authenticated: true, mfaRequired: true, mfaVerified: true } },
    ]);

    await expect(resolvePostSignInPath('/dashboard', 0)).resolves.toBe('/dashboard');
  });

  // The point of the whole module: the cookie is not there on the first probe.
  it('keeps polling until the cookie lands', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { authenticated: false } },
      { ok: true, body: { authenticated: false } },
      { ok: true, body: { authenticated: true } },
    ]);

    await expect(resolvePostSignInPath('/dashboard', 0)).resolves.toBe('/dashboard');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('survives a network blip mid-poll', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    global.fetch = fn as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(resolvePostSignInPath('/dashboard', 0)).resolves.toBe('/dashboard');
  });

  // Every other case passes settleMs: 0 for suite speed, which would leave the
  // default — the value /login and /register actually use — unexercised.
  it('applies the default settle when none is given', async () => {
    mockFetch([{ ok: true, body: { authenticated: true } }]);

    const started = performance.now();
    await expect(resolvePostSignInPath('/dashboard')).resolves.toBe('/dashboard');
    expect(performance.now() - started).toBeGreaterThanOrEqual(400);
  });

  // Failing open is deliberate: proxy.ts is the authoritative gate, so the
  // worst case is one redirect rather than a user stranded on a spinner.
  it('gives up after the retry budget and returns the target anyway', async () => {
    const fetchMock = mockFetch([{ ok: true, body: { authenticated: false } }]);

    await expect(resolvePostSignInPath('/dashboard', 0)).resolves.toBe('/dashboard');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
