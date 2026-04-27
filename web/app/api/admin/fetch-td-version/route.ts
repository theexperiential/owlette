import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

const TD_ARCHIVE_URL = 'https://derivative.ca/download/archive';
const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

// Match TouchDesigner full installer URLs: TouchDesigner.YYYY.NNNNN.exe
const TD_FULL_REGEX = /https:\/\/download\.derivative\.ca\/TouchDesigner\.(\d{4}\.\d{4,5})\.exe/g;

// Match TouchDesigner web installer URLs: TouchDesignerWebInstaller.YYYY.NNNNN.exe
const TD_WEB_REGEX = /https:\/\/download\.derivative\.ca\/TouchDesignerWebInstaller\.(\d{4}\.\d{4,5})\.exe/g;

interface TdBuild {
  version: string;
  full_installer_url: string;
  web_installer_url: string | null;
}

/**
 * GET /api/admin/fetch-td-version
 *
 * Scrapes derivative.ca/download/archive to find available TouchDesigner builds.
 * Returns the latest build with download URLs.
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: Capability.SYSTEM_PRESET_MANAGE,
    targetKind: 'preset',
    apiKeyScope: { resource: 'user', permission: 'admin' },
    deprecated: true,
    canonicalUrl: '/api/admin/system-presets',
    sunsetDate: LEGACY_ADMIN_SUNSET,
    routeName: 'GET /api/admin/fetch-td-version',
  })(
  async (_request: NextRequest) => {
    try {
      const response = await fetch(TD_ARCHIVE_URL, {
        headers: {
          'User-Agent': 'Owlette/2.3 (deployment-manager)',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.error(`fetch-td-version: derivative.ca returned ${response.status}`);
        return NextResponse.json(
          { error: `derivative.ca returned ${response.status}` },
          { status: 502 }
        );
      }

      const html = await response.text();

      // Extract all full installer matches
      const fullMatches = [...html.matchAll(TD_FULL_REGEX)];
      if (fullMatches.length === 0) {
        logger.warn('fetch-td-version: no TouchDesigner downloads found on page');
        return NextResponse.json(
          { error: 'No TouchDesigner downloads found on archive page' },
          { status: 404 }
        );
      }

      // Extract web installer matches
      const webMatches = [...html.matchAll(TD_WEB_REGEX)];
      const webVersionMap = new Map<string, string>();
      for (const match of webMatches) {
        webVersionMap.set(match[1], match[0]);
      }

      // Build list of unique versions (preserve page order = latest first)
      const seen = new Set<string>();
      const builds: TdBuild[] = [];

      for (const match of fullMatches) {
        const version = match[1];
        if (seen.has(version)) continue;
        seen.add(version);

        builds.push({
          version,
          full_installer_url: match[0],
          web_installer_url: webVersionMap.get(version) || null,
        });
      }

      return NextResponse.json({
        latest: builds[0],
        builds: builds.slice(0, 10),
        scraped_at: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const errName = error instanceof Error ? error.name : undefined;
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        logger.error('fetch-td-version: timeout fetching derivative.ca');
        return NextResponse.json(
          { error: 'Timeout fetching derivative.ca' },
          { status: 504 }
        );
      }
      return apiError(error, 'admin/fetch-td-version');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
