import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken } from '@/lib/apiAuth.server';
import { getToolsByTier, type ToolTier } from '@/lib/mcp-tools';
import { apiError } from '@/lib/apiErrorResponse';

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
  async (request: NextRequest) => {
    try {
      await requireAdminOrIdToken(request);

      const tierParam = request.nextUrl.searchParams.get('tier');
      const maxTier = tierParam ? (Math.min(Math.max(parseInt(tierParam, 10), 1), 3) as ToolTier) : 3;

      const tools = getToolsByTier(maxTier);

      return NextResponse.json({ tools, count: tools.length });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/tools');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
