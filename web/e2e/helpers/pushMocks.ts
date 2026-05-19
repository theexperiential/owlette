/**
 * push-flow mocks for the v2 (roost) browser upload pipeline.
 *
 * the browser-side `uploadFolder` (web/lib/roostUpload.ts) makes three
 * kinds of HTTP calls during a push:
 *
 *   1. POST /api/chunks/check        — { siteId, hashes } → { missing }
 *   2. POST /api/chunks/upload-urls  — { siteId, hashes } → { urls, expiresAt }
 *   3. PUT  <signed-r2-url>          — chunk bytes (no body required by us)
 *
 * `installPushMocks` intercepts all three so a spec can drive the real
 * dialog → useRoostUpload → uploadFolder pipeline without standing up
 * R2 or producing real signed URLs. by default the /check mock returns
 * `missing: []`, which short-circuits the upload phase entirely (the
 * pipeline skips straight to /api/roosts/{id}/versions). pass
 * `opts.missing` to force the browser to mint upload URLs and PUT to
 * the R2 fake — useful when a spec wants to assert against the upload
 * progress phase.
 *
 * the mocks are tightly scoped: only `/api/chunks/check`,
 * `/api/chunks/upload-urls`, and the e2e-mock R2 host pattern. real
 * `/api/roosts/*` and `/api/agent/*` requests still hit next, so the
 * version-finalize step exercises production code paths.
 *
 * REQUIRES `seedChunks(siteId, hashes)` for any digest the test version
 * envelope references. The finalize handler at /api/roosts/{id}/versions
 * runs `verifyChunksPresent` server-side, which calls `hasChunk(siteId,
 * hash)`. Under e2e (`OWLETTE_E2E=1`, set in `playwright.config.ts`),
 * `hasChunk` reads `siteChunks/{digest}` from Firestore instead of doing
 * a real R2 HeadObject. Forgetting to seed the presence row results in a
 * 412 `chunks missing in storage` from the finalize call. See
 * `web/e2e/helpers/seed.ts:seedChunks` + `web/lib/r2Client.server.ts:hasChunk`.
 */

import type { Page, Route, Request } from '@playwright/test';

/**
 * Same-origin path we hand back from the upload-urls mock. Keeping the fake
 * signed URL on the app origin still exercises the browser upload queue while
 * avoiding cross-origin preflight differences between local Chrome and CI.
 */
const MOCK_R2_PATH_PREFIX = '/__e2e-r2/put';

/**
 * matches the URLs the browser PUTs chunk bytes to. covers our same-origin
 * mock path plus the real R2 hostnames, in case a spec accidentally routes
 * against a real signed URL — we still want to absorb those rather than make
 * a network call from the e2e runner.
 */
const R2_PUT_PATTERN = /(\/__e2e-r2\/put\/|r2[.-]mock|owlette-.*\.r2\.cloudflarestorage\.com|e2e-mock-r2\.test)/i;

/** Glob patterns we install on `page.route()`. exposed so uninstall can mirror them. */
const CHECK_GLOB = '**/api/chunks/check';
const UPLOAD_URLS_GLOB = '**/api/chunks/upload-urls';

export interface InstallPushMocksOptions {
  /**
   * hashes the /chunks/check mock should report as missing. defaults to
   * `[]` (everything already present → upload phase is a no-op). pass an
   * explicit list to drive the upload-urls + R2 PUT path.
   */
  missing?: string[];
}

/**
 * install playwright `page.route()` interceptors for the v2 push flow.
 *
 * safe to call repeatedly — re-installing replaces prior handlers (we
 * unroute first). pair with `uninstallPushMocks` in `afterEach` for
 * isolation across tests.
 */
export async function installPushMocks(
  page: Page,
  opts: InstallPushMocksOptions = {},
): Promise<void> {
  // idempotent: tear down any prior install before re-registering.
  await uninstallPushMocks(page);

  const missing = opts.missing ?? [];

  await page.route(CHECK_GLOB, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ missing }),
    });
  });

  await page.route(UPLOAD_URLS_GLOB, async (route: Route, request: Request) => {
    let hashes: string[] = [];
    try {
      const body = request.postDataJSON() as { hashes?: unknown };
      if (Array.isArray(body?.hashes)) {
        hashes = body.hashes.filter((h): h is string => typeof h === 'string');
      }
    } catch {
      // postDataJSON throws on non-JSON bodies; fall through with empty hashes.
    }

    const urls: Record<string, string> = {};
    for (const hash of hashes) {
      urls[hash] = `${MOCK_R2_PATH_PREFIX}/${encodeURIComponent(hash)}?sig=fake`;
    }
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ urls, expiresAt }),
    });
  });

  await page.route(R2_PUT_PATTERN, async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'PUT, OPTIONS',
        'access-control-allow-headers': '*',
      },
    });
  });
}

/**
 * remove every `page.route()` handler installed by `installPushMocks`.
 * call in `afterEach` so handlers don't leak across tests. safe to call
 * even if `installPushMocks` was never invoked — `unroute` is a no-op
 * when no matching handler is registered.
 */
export async function uninstallPushMocks(page: Page): Promise<void> {
  await page.unroute(CHECK_GLOB);
  await page.unroute(UPLOAD_URLS_GLOB);
  await page.unroute(R2_PUT_PATTERN);
}
