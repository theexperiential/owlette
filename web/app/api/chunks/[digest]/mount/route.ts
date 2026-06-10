/**
 * POST /api/chunks/{digest}/mount?from=<roostId>&to=<roostId>&siteId=...
 *      (siteId + from + to can also be supplied in a JSON body)
 *
 * Records a cross-roost chunk reference. NO bytes are copied — chunks
 * are stored once per site at `project-content/{siteId}/{hash[:2]}/{hash}`,
 * so "mount" is purely a metadata/reference-count operation.
 *
 * Writes an idempotent entry to
 *   sites/{siteId}/chunk_referrers/{hash}/entries/mount_{from}_{to}
 * which `GET /referrers` paginates over.
 *
 * roost public api wave 3.4.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { hasChunk } from '@/lib/r2Client.server';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  parseJsonBody,
  requireDistributionManageCapability,
  requireSiteAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ digest: string }>;
}

interface MountBody {
  siteId?: unknown;
  from?: unknown;
  to?: unknown;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { digest } = await params;
    if (!SHA256_HEX_RE.test(digest)) {
      return problemValidation('digest must be a 64-char lowercase sha-256 hex', {
        digest: ['must match ^[0-9a-f]{64}$'],
      });
    }

    // Query params win over body for the common gh-style invocation
    // `?from=x&to=y&siteId=z`; body supported for programmatic clients.
    const qp = request.nextUrl.searchParams;
    const siteIdRaw = qp.get('siteId');
    const fromRaw = qp.get('from');
    const toRaw = qp.get('to');

    let body: MountBody = {};
    if (!siteIdRaw || !fromRaw || !toRaw) {
      // Only try to parse body if any required value is missing in query.
      // parseJsonBody returns an error problem when body is absent or
      // invalid — avoid that by only reading body when needed and
      // gracefully defaulting.
      const contentLength = Number(request.headers.get('content-length') ?? 0);
      if (contentLength > 0) {
        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        body = parsed.body as MountBody;
      }
    }

    const siteIdCandidate: unknown = siteIdRaw ?? body.siteId;
    const site = validateSiteIdBody(siteIdCandidate);
    if (!site.ok) return site.response;

    const fromCandidate = typeof fromRaw === 'string' ? fromRaw : body.from;
    const toCandidate = typeof toRaw === 'string' ? toRaw : body.to;
    if (typeof fromCandidate !== 'string' || typeof toCandidate !== 'string') {
      return problemValidation('from and to roost ids are required (query params or body)', {
        from: typeof fromCandidate !== 'string' ? ['required'] : [],
        to: typeof toCandidate !== 'string' ? ['required'] : [],
      });
    }
    const fromErr = validateResourceId(fromCandidate, 'from');
    if (fromErr) return fromErr;
    const toErr = validateResourceId(toCandidate, 'to');
    if (toErr) return toErr;

    if (fromCandidate === toCandidate) {
      return problemValidation('from and to must be different roost ids', {
        to: ['must differ from `from`'],
      });
    }

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'write');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireDistributionManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    // Zero-byte check: the chunk must already exist under this site. Mount
    // never moves/copies bytes.
    const present = await hasChunk(site.siteId, digest);
    if (!present) {
      return problem({
        type: ProblemType.NotFound,
        title: 'chunk not found',
        status: 404,
        detail: `chunk ${digest} is not stored for site ${site.siteId}`,
        instance: `/api/chunks/${digest}/mount`,
      });
    }

    // Verify both roosts exist (prevents mounting into/out-of phantom roosts).
    const db = getAdminDb();
    const roostsCol = db.collection('sites').doc(site.siteId).collection('roosts');
    const [fromSnap, toSnap] = await Promise.all([
      roostsCol.doc(fromCandidate).get(),
      roostsCol.doc(toCandidate).get(),
    ]);
    if (!fromSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'source roost not found',
        status: 404,
        detail: `roost ${fromCandidate} not found on site ${site.siteId}`,
        instance: `/api/chunks/${digest}/mount`,
      });
    }
    if (!toSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'target roost not found',
        status: 404,
        detail: `roost ${toCandidate} not found on site ${site.siteId}`,
        instance: `/api/chunks/${digest}/mount`,
      });
    }

    // Idempotent entry — same (from, to) pair maps to the same doc id, so
    // repeat mounts from the same client don't double-count.
    const entryId = `mount_${fromCandidate}_${toCandidate}`;
    const entryRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('chunk_referrers')
      .doc(digest)
      .collection('entries')
      .doc(entryId);

    await entryRef.set(
      {
        digest,
        source: 'mount',
        fromRoostId: fromCandidate,
        toRoostId: toCandidate,
        mountedAt: FieldValue.serverTimestamp(),
        referencedAt: FieldValue.serverTimestamp(),
        mountedBy: auth.userId,
      },
      { merge: true },
    );

    emitMutation({
      kind: 'chunk_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: digest,
      attributes: {
        verb: 'mount',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        fromRoostId: fromCandidate,
        toRoostId: toCandidate,
        entryId,
        zeroByte: true,
      },
    });

    return applyAuthDeprecations(
      NextResponse.json(
        {
          digest,
          siteId: site.siteId,
          from: fromCandidate,
          to: toCandidate,
          mounted: true,
          zeroByte: true,
        },
        { status: 201 },
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/chunks/[digest]/mount:POST');
  }
}
