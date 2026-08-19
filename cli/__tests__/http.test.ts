/**
 * Trial-countdown advisory surfacing (billing-system wave 3.3).
 *
 * The api sets `X-Owlette-Billing-Warning` on every response while the
 * account's free trial is running. The CLI prints it to stderr **once per
 * process invocation** — a command that pages through ten requests must not
 * repeat the same line ten times.
 *
 * The once-per-process latch is module state, so every test re-imports the
 * module through `jest.isolateModulesAsync` to get a fresh process's worth of
 * behaviour.
 */

const WARNING = 'trial ends 2026-08-15T00:00:00.000Z; choose a plan to keep API access';

type HttpModule = typeof import('../src/lib/http');

/** Load a pristine copy of `lib/http` and hand it to `fn`. */
async function withFreshModule(fn: (mod: HttpModule) => Promise<void> | void): Promise<void> {
  await jest.isolateModulesAsync(async () => {
    const mod: HttpModule = await import('../src/lib/http');
    await fn(mod);
  });
}

/** Capture everything written to stderr for the duration of `fn`. */
async function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  let captured = '';
  const spy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

function responseWith(headers: Record<string, string> = {}): Response {
  return new Response('{}', { status: 200, headers });
}

describe('noteBillingWarning', () => {
  it('prints the warning to stderr with the owlette: prefix', async () => {
    await withFreshModule(async (mod) => {
      const out = await captureStderr(() => {
        mod.noteBillingWarning(responseWith({ 'X-Owlette-Billing-Warning': WARNING }));
      });
      expect(out).toBe(`owlette: ${WARNING}\n`);
    });
  });

  it('prints at most once per process, across many responses', async () => {
    await withFreshModule(async (mod) => {
      const out = await captureStderr(() => {
        for (let i = 0; i < 10; i++) {
          mod.noteBillingWarning(responseWith({ 'X-Owlette-Billing-Warning': WARNING }));
        }
      });
      expect(out.match(/owlette: trial ends/g)).toHaveLength(1);
    });
  });

  it('stays silent when the response carries no warning', async () => {
    await withFreshModule(async (mod) => {
      const out = await captureStderr(() => {
        mod.noteBillingWarning(responseWith());
      });
      expect(out).toBe('');
    });
  });

  it('matches the header case-insensitively', async () => {
    await withFreshModule(async (mod) => {
      const out = await captureStderr(() => {
        mod.noteBillingWarning(responseWith({ 'x-owlette-billing-warning': WARNING }));
      });
      expect(out).toContain(WARNING);
    });
  });

  it('does not latch on a warning-free response — a later warning still prints', async () => {
    await withFreshModule(async (mod) => {
      const out = await captureStderr(() => {
        mod.noteBillingWarning(responseWith());
        mod.noteBillingWarning(responseWith({ 'X-Owlette-Billing-Warning': WARNING }));
      });
      expect(out).toBe(`owlette: ${WARNING}\n`);
    });
  });
});

describe('fetchWithTimeout billing advisory', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('surfaces the warning once across repeated requests', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(responseWith({ 'X-Owlette-Billing-Warning': WARNING })) as typeof fetch;

    await withFreshModule(async (mod) => {
      const out = await captureStderr(async () => {
        // A paging command: three requests, one warning.
        await mod.fetchWithTimeout('https://owlette.app/api/roosts');
        await mod.fetchWithTimeout('https://owlette.app/api/roosts?page_token=a');
        await mod.fetchWithTimeout('https://owlette.app/api/roosts?page_token=b');
      });
      expect(out).toBe(`owlette: ${WARNING}\n`);
    });
  });

  it('returns the response unchanged', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'X-Owlette-Billing-Warning': WARNING },
        }),
      ) as typeof fetch;

    await withFreshModule(async (mod) => {
      await captureStderr(async () => {
        const res = await mod.fetchWithTimeout('https://owlette.app/api/roosts');
        expect(res.status).toBe(201);
        await expect(res.json()).resolves.toEqual({ ok: true });
      });
    });
  });

  it('stays silent for a subscribed account (no header)', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(responseWith()) as typeof fetch;

    await withFreshModule(async (mod) => {
      const out = await captureStderr(async () => {
        await mod.fetchWithTimeout('https://owlette.app/api/roosts');
      });
      expect(out).toBe('');
    });
  });

  it('does not swallow fetch rejections', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('econnrefused')) as typeof fetch;

    await withFreshModule(async (mod) => {
      await expect(mod.fetchWithTimeout('https://owlette.app/api/roosts')).rejects.toThrow(
        'econnrefused',
      );
    });
  });
});
