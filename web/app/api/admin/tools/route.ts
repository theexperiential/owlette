import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getToolsByTier, type ToolTier } from '@/lib/mcp-tools';
import { apiError } from '@/lib/apiErrorResponse';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * GET /api/admin/tools
 *
 * List all available MCP tools with schemas.
 * Optional query param: ?tier=1|2|3 (max tier to include, default: 3)
 *
 * Response:
 *   { tools: McpToolDefinition[], count: number }
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: Capability.MACHINE_EXEC_COMMAND,
    targetKind: 'site',
    apiKeyScope: { resource: 'user', permission: 'admin' },
    deprecated: true,
    canonicalUrl: '/api/cortex/tools',
    sunsetDate: LEGACY_ADMIN_SUNSET,
    routeName: 'GET /api/admin/tools',
  })(
  async (request: NextRequest) => {
    try {
      const tierParam = request.nextUrl.searchParams.get('tier');
      const maxTier = tierParam ? (Math.min(Math.max(parseInt(tierParam, 10), 1), 3) as ToolTier) : 3;

      const tools = getToolsByTier(maxTier);

      return NextResponse.json({ tools, count: tools.length });
    } catch (error: unknown) {
      return apiError(error, 'admin/tools');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
