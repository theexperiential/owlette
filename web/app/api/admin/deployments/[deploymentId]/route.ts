import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess, getRouteParam } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/**
 * GET /api/admin/deployments/{deploymentId}?siteId=xxx
 *
 * Get full deployment status including all target machine statuses.
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      // /api/admin/deployments/{deploymentId} → segments: ['api','admin','deployments','{id}']
      const deploymentId = getRouteParam(request, 3);
      const siteId = request.nextUrl.searchParams.get('siteId');

      if (!siteId) {
        return NextResponse.json(
          { error: 'Missing required query param: siteId' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();
      const deploymentRef = db.collection('sites').doc(siteId).collection('deployments').doc(deploymentId);
      const deploymentSnap = await deploymentRef.get();

      if (!deploymentSnap.exists) {
        return NextResponse.json(
          { error: 'Deployment not found' },
          { status: 404 }
        );
      }

      const data = deploymentSnap.data()!;

      return NextResponse.json({
        success: true,
        deployment: {
          id: deploymentSnap.id,
          name: data.name || 'Unnamed Deployment',
          installer_name: data.installer_name || '',
          installer_url: data.installer_url || '',
          silent_flags: data.silent_flags || '',
          verify_path: data.verify_path || undefined,
          targets: data.targets || [],
          createdAt: data.createdAt || 0,
          completedAt: data.completedAt || undefined,
          status: data.status || 'pending',
        },
      });
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
  { strategy: 'user', identifier: 'ip' }
);

const TERMINAL_STATUSES = ['completed', 'failed', 'partial', 'uninstalled'];

/**
 * DELETE /api/admin/deployments/{deploymentId}?siteId=xxx
 *
 * Delete a deployment record. Only allowed if deployment is in a terminal state.
 */
export const DELETE = withRateLimit(
  async (request: NextRequest) => {
    try {
      const deploymentId = getRouteParam(request, 3);
      const siteId = request.nextUrl.searchParams.get('siteId');

      if (!siteId) {
        return NextResponse.json(
          { error: 'Missing required query param: siteId' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();
      const deploymentRef = db.collection('sites').doc(siteId).collection('deployments').doc(deploymentId);
      const deploymentSnap = await deploymentRef.get();

      if (!deploymentSnap.exists) {
        return NextResponse.json(
          { error: 'Deployment not found' },
          { status: 404 }
        );
      }

      const status = deploymentSnap.data()?.status;
      if (!TERMINAL_STATUSES.includes(status)) {
        return NextResponse.json(
          { error: `Cannot delete deployment in "${status}" state. Must be: ${TERMINAL_STATUSES.join(', ')}` },
          { status: 409 }
        );
      }

      await deploymentRef.delete();

      logger.info(`Deployment deleted: ${deploymentId}`, { context: 'admin/deployments' });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/deployments DELETE:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
