import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import logger from '@/lib/logger';

/**
 * POST /api/admin/machines/update
 *
 * Trigger an Owlette agent self-update on selected machines (or all online machines for a site).
 *
 * Request body:
 *   siteId: string (required)
 *   machineIds?: string[] (optional — if omitted, targets all online machines for the site)
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json();
      const { siteId, machineIds: requestedMachineIds } = body;

      if (!siteId) {
        return NextResponse.json(
          { error: 'Missing required field: siteId' },
          { status: 400 }
        );
      }

      if (requestedMachineIds && (!Array.isArray(requestedMachineIds) || requestedMachineIds.length === 0)) {
        return NextResponse.json(
          { error: 'machineIds must be a non-empty array if provided' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();

      // Get latest installer metadata
      const latestDoc = await db.collection('installer_metadata').doc('latest').get();

      if (!latestDoc.exists) {
        return NextResponse.json(
          { error: 'No installer uploaded yet. Upload one via Admin → Installers.' },
          { status: 404 }
        );
      }

      const installerData = latestDoc.data()!;
      const downloadUrl = installerData.download_url || installerData.downloadUrl;
      const targetVersion = installerData.version;
      const checksumSha256 = installerData.checksum_sha256;

      if (!downloadUrl) {
        return NextResponse.json(
          { error: 'Installer download URL not available.' },
          { status: 500 }
        );
      }

      if (!checksumSha256) {
        return NextResponse.json(
          { error: 'Installer checksum not available. Re-upload the installer via Admin → Installers.' },
          { status: 500 }
        );
      }

      // Resolve target machines
      let machineIds: string[];

      if (requestedMachineIds) {
        machineIds = requestedMachineIds;
      } else {
        // Get all online machines for the site
        const machinesSnap = await db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .where('online', '==', true)
          .get();

        machineIds = machinesSnap.docs.map(doc => doc.id);

        if (machineIds.length === 0) {
          return NextResponse.json(
            { error: 'No online machines found for this site.' },
            { status: 404 }
          );
        }
      }

      // Send update_owlette command to each machine in parallel
      const results = await Promise.allSettled(
        machineIds.map(async (machineId) => {
          const commandId = `update_owlette_${Date.now()}_${machineId}`;
          const pendingRef = db
            .collection('sites')
            .doc(siteId)
            .collection('machines')
            .doc(machineId)
            .collection('commands')
            .doc('pending');

          await pendingRef.set(
            {
              [commandId]: {
                type: 'update_owlette',
                installer_url: downloadUrl,
                target_version: targetVersion,
                checksum_sha256: checksumSha256,
                timestamp: FieldValue.serverTimestamp(),
                status: 'pending',
              },
            },
            { merge: true }
          );

          return { machineId, commandId };
        })
      );

      // Collect results
      const succeeded: { machineId: string; commandId: string }[] = [];
      const failed: { machineId: string; error: string }[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          succeeded.push(result.value);
        } else {
          failed.push({
            machineId: machineIds[index],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });

      logger.info(
        `Update v${targetVersion} sent to ${succeeded.length}/${machineIds.length} machines in site ${siteId}`,
        { context: 'admin/machines/update' }
      );

      return NextResponse.json({
        success: succeeded.length > 0,
        version: targetVersion,
        sent: succeeded.length,
        failed: failed.length,
        machines: succeeded,
        errors: failed.length > 0 ? failed : undefined,
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/machines/update:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
