import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/admin/software-inventory?siteId=xxx&machineId=xxx&search=xxx
 *
 * Query installed software for a machine from the agent's registry sync.
 * Optionally filter by search term (case-insensitive substring match on name).
 *
 * Returns matching entries with uninstall commands and installer types,
 * useful for programmatic uninstall via the commands/send endpoint.
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const siteId = request.nextUrl.searchParams.get('siteId');
      const machineId = request.nextUrl.searchParams.get('machineId');
      const search = request.nextUrl.searchParams.get('search');

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required query params: siteId, machineId' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();
      const inventoryRef = db
        .collection('sites').doc(siteId)
        .collection('machines').doc(machineId)
        .collection('installed_software');

      const snapshot = await inventoryRef.get();

      let software = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name || '',
          version: data.version || '',
          publisher: data.publisher || '',
          install_location: data.install_location || '',
          uninstall_command: data.uninstall_command || '',
          installer_type: data.installer_type || 'custom',
        };
      });

      // Filter by search term if provided
      if (search) {
        const searchLower = search.toLowerCase();
        software = software.filter((s) =>
          s.name.toLowerCase().includes(searchLower)
        );
      }

      return NextResponse.json({ success: true, software });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/software-inventory');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
