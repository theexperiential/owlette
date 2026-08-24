/**
 * push-flow mocks for the roost browser upload pipeline. `installPushMocks`
 * intercepts the three calls `uploadFolder` makes — POST /api/chunks/check,
 * POST /api/chunks/upload-urls, PUT <signed-r2-url> — so a spec drives the real
 * dialog → useRoostUpload → uploadFolder path without R2. /check returns
 * `missing: []` by default (upload phase skipped); pass `opts.missing` to
 * exercise upload-urls + PUT. `/api/roosts/*` and `/api/agent/*` are NOT mocked,
 * so version-finalize runs production code.
 *
 * REQUIRES `seedChunks(siteId, hashes)` for every digest the version envelope
 * references: finalize calls `verifyChunksPresent` → `hasChunk`, which under
 * `OWLETTE_E2E=1` reads `siteChunks/{digest}` from Firestore. Unseeded → 412
 * `chunks missing in storage`.
 */

import type { Page, Route, Request } from '@playwright/test';

/**
 * Fake signed URL kept same-origin: still exercises the upload queue but avoids
 * cross-origin preflight differences between local Chrome and CI.
 */
const MOCK_R2_PATH_PREFIX = '/__e2e-r2/put';

/**
 * URLs the browser PUTs chunk bytes to — the same-origin mock path plus real R2
 * hostnames, so a stray real signed URL is absorbed instead of hitting network.
 */
const R2_PUT_PATTERN = /(\/__e2e-r2\/put\/|r2[.-]mock|owlette-.*\.r2\.cloudflarestorage\.com|e2e-mock-r2\.test)/i;

/** Glob patterns installed on `page.route()`; exported so uninstall mirrors them. */
const CHECK_GLOB = '**/api/chunks/check';
const UPLOAD_URLS_GLOB = '**/api/chunks/upload-urls';

export interface InstallPushMocksOptions {
  /** Hashes /chunks/check reports missing; `[]` (default) skips the upload phase. */
  missing?: string[];
}

/**
 * Install the push-flow `page.route()` interceptors. Safe to call repeatedly
 * (unroutes first); pair with `uninstallPushMocks` in `afterEach`.
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
      // postDataJSON throws on non-JSON bodies — fall through with empty hashes.
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
 * Remove every handler `installPushMocks` registered. Safe when it was never
 * called — `unroute` no-ops on unmatched patterns.
 */
export async function uninstallPushMocks(page: Page): Promise<void> {
  await page.unroute(CHECK_GLOB);
  await page.unroute(UPLOAD_URLS_GLOB);
  await page.unroute(R2_PUT_PATTERN);
}
