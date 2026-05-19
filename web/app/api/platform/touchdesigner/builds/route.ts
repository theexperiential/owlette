import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

const TD_ARCHIVE_URL = 'https://derivative.ca/download/archive';

const TD_FULL_REGEX = /https:\/\/download\.derivative\.ca\/TouchDesigner\.(\d{4}\.\d{4,5})\.exe/g;
const TD_WEB_REGEX = /https:\/\/download\.derivative\.ca\/TouchDesignerWebInstaller\.(\d{4}\.\d{4,5})\.exe/g;

interface TdBuild {
  version: string;
  full_installer_url: string;
  web_installer_url: string | null;
}

/**
 * GET /api/platform/touchdesigner/builds
 *
 * Scrapes derivative.ca/download/archive to find available TouchDesigner builds.
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: Capability.SYSTEM_PRESET_MANAGE,
    targetKind: 'preset',
    apiKeyScope: { resource: 'user', permission: 'admin' },
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
        logger.error(`touchdesigner/builds: derivative.ca returned ${response.status}`);
        return NextResponse.json(
          { error: `derivative.ca returned ${response.status}` },
          { status: 502 },
        );
      }

      const html = await response.text();
      const fullMatches = [...html.matchAll(TD_FULL_REGEX)];
      if (fullMatches.length === 0) {
        logger.warn('touchdesigner/builds: no TouchDesigner downloads found on page');
        return NextResponse.json(
          { error: 'No TouchDesigner downloads found on archive page' },
          { status: 404 },
        );
      }

      const webMatches = [...html.matchAll(TD_WEB_REGEX)];
      const webVersionMap = new Map<string, string>();
      for (const match of webMatches) {
        webVersionMap.set(match[1], match[0]);
      }

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
        logger.error('touchdesigner/builds: timeout fetching derivative.ca');
        return NextResponse.json(
          { error: 'Timeout fetching derivative.ca' },
          { status: 504 },
        );
      }
      return apiError(error, 'platform/touchdesigner/builds');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);
