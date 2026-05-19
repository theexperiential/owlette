/**
 * `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/stop`
 *
 * Queue a `stop_process` command (graceful). Idempotent (Idempotency-Key required).
 */

import { NextRequest } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { handleControlVerb } from '../_helpers';

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string; processId: string }>;
}

export const POST = withRateLimit(
  (request: NextRequest, context: RouteContext) => handleControlVerb('stop', request, context),
  { strategy: 'api', identifier: 'ip' }
);
