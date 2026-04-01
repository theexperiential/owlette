import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/**
 * GET /api/admin/deployments?siteId=xxx&limit=20
 *
 * List deployments for a site, ordered by creation date (newest first).
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const siteId = request.nextUrl.searchParams.get('siteId');

      if (!siteId) {
        return NextResponse.json(
          { error: 'Missing required query param: siteId' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const limitParam = request.nextUrl.searchParams.get('limit');
      const queryLimit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100);

      const db = getAdminDb();
      const deploymentsRef = db.collection('sites').doc(siteId).collection('deployments');
      const snapshot = await deploymentsRef
        .orderBy('createdAt', 'desc')
        .limit(queryLimit)
        .get();

      const deployments = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name || 'Unnamed Deployment',
          installer_name: data.installer_name || '',
          installer_url: data.installer_url || '',
          silent_flags: data.silent_flags || '',
          verify_path: data.verify_path || undefined,
          targets: data.targets || [],
          createdAt: data.createdAt || 0,
          completedAt: data.completedAt || undefined,
          status: data.status || 'pending',
        };
      });

      return NextResponse.json({ success: true, deployments });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/deployments GET:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/**
 * POST /api/admin/deployments
 *
 * Create a new deployment — creates deployment doc and sends install_software
 * commands to each target machine.
 *
 * Request body:
 *   siteId: string
 *   name: string
 *   installer_name: string
 *   installer_url: string
 *   silent_flags: string
 *   verify_path?: string
 *   machineIds: string[]
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json();
      const { siteId, name, installer_name, installer_url, silent_flags, verify_path, parallel_install, machineIds } = body;

      if (!siteId || !name || !installer_name || !installer_url || !silent_flags) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, name, installer_name, installer_url, silent_flags' },
          { status: 400 }
        );
      }

      if (!machineIds || !Array.isArray(machineIds) || machineIds.length === 0) {
        return NextResponse.json(
          { error: 'machineIds must be a non-empty array' },
          { status: 400 }
        );
      }

      // Validate installer_url is a valid HTTPS URL
      try {
        const parsedUrl = new URL(installer_url);
        if (parsedUrl.protocol !== 'https:') {
          return NextResponse.json(
            { error: 'installer_url must use HTTPS protocol' },
            { status: 400 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: 'installer_url must be a valid URL' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();
      const deploymentId = `deploy-${Date.now()}`;
      const deploymentRef = db.collection('sites').doc(siteId).collection('deployments').doc(deploymentId);

      // Initialize targets with pending status
      const targets = machineIds.map((machineId: string) => ({
        machineId,
        status: 'pending',
      }));

      // Create deployment document
      const deploymentData: Record<string, unknown> = {
        name,
        installer_name,
        installer_url,
        silent_flags,
        targets,
        createdAt: Date.now(),
        status: 'pending',
      };

      if (verify_path) {
        deploymentData.verify_path = verify_path;
      }
      if (parallel_install) {
        deploymentData.parallel_install = true;
      }

      await deploymentRef.set(deploymentData);

      // Send install_software command to each machine in parallel
      // (mirrors createDeployment in useDeployments.ts)
      const commandPromises = machineIds.map(async (machineId: string) => {
        const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
        const sanitizedMachineId = machineId.replace(/-/g, '_');
        const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${Date.now()}`;

        const pendingRef = db
          .collection('sites').doc(siteId)
          .collection('machines').doc(machineId)
          .collection('commands').doc('pending');

        const commandData: Record<string, unknown> = {
          type: 'install_software',
          installer_url,
          installer_name,
          silent_flags,
          deployment_id: deploymentId,
          timestamp: Date.now(),
          status: 'pending',
        };

        if (verify_path) {
          commandData.verify_path = verify_path;
        }
        if (parallel_install) {
          commandData.parallel_install = true;
        }

        await pendingRef.set({ [commandId]: commandData }, { merge: true });
      });

      await Promise.all(commandPromises);

      // Update deployment status to in_progress
      await deploymentRef.update({ status: 'in_progress' });

      logger.info(`Deployment created: ${deploymentId} targeting ${machineIds.length} machines`, {
        context: 'admin/deployments',
      });

      return NextResponse.json({ success: true, deploymentId });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/deployments POST:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
