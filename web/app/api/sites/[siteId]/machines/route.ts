/**
 * GET /api/sites/{siteId}/machines
 *      → List all machines in a site with online status + current roost summary.
 *
 * Each row includes `currentRoosts`: the roosts whose `targets[]` include this
 * machine, with their currentManifestId so operators can see "what's this
 * machine running right now" at a glance.
 *
 * roost public api wave 3.6.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

interface RoostSummary {
  roostId: string;
  name: string;
  currentManifestId: string | null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteRef = db.collection('sites').doc(siteId);

    // Parallel fetch: machines + roosts. The roosts set drives the per-
    // machine current-roost summary.
    const [machinesSnap, roostsSnap] = await Promise.all([
      siteRef.collection('machines').get(),
      siteRef.collection('roosts').get(),
    ]);

    // Build machineId → roost summaries[] index.
    const roostsByMachine = new Map<string, RoostSummary[]>();
    for (const roostDoc of roostsSnap.docs) {
      const data = roostDoc.data();
      if (data.deletedAt) continue;
      const targets = Array.isArray(data.targets) ? (data.targets as string[]) : [];
      const summary: RoostSummary = {
        roostId: roostDoc.id,
        name: typeof data.name === 'string' ? data.name : roostDoc.id,
        currentManifestId: typeof data.currentManifestId === 'string' ? data.currentManifestId : null,
      };
      for (const machineId of targets) {
        const existing = roostsByMachine.get(machineId);
        if (existing) existing.push(summary);
        else roostsByMachine.set(machineId, [summary]);
      }
    }

    const machines = machinesSnap.docs.map((d) => {
      const data = d.data();
      const lastHeartbeat = data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null;
      return {
        id: d.id,
        name: typeof data.name === 'string'
          ? data.name
          : typeof data.machine_name === 'string'
            ? data.machine_name
            : d.id,
        online: data.online === true,
        lastHeartbeat: heartbeatToIso(lastHeartbeat),
        agentVersion:
          data.agent_version ?? data.presence?.agent_version ?? null,
        os: data.os ?? data.presence?.os ?? null,
        currentRoosts: roostsByMachine.get(d.id) ?? [],
      };
    });

    machines.sort((a, b) => a.name.localeCompare(b.name));

    return applyAuthDeprecations(
      NextResponse.json({ machines }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/machines:GET');
  }
}

function heartbeatToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}
