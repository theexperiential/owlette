/**
 * POST /api/sites/{siteId}/machines/{machineId}/screenshots/finalize
 *
 * Final step of the agent's `capture_screenshot` pipeline. The agent
 * has just PUT image bytes to the signed URL returned by
 * `/screenshots/upload-url`. This endpoint:
 *
 *   1. Verifies the object actually landed at `storagePath` (HEAD via
 *      Firebase Storage admin) and that its path belongs to *this*
 *      site+machine (defense-in-depth — the agent token's
 *      machine_id is already checked by requireMachineAuthAndScope, but
 *      we also reject paths that don't match the URL params).
 *   2. Flips the object to public-read via `file.makePublic()`. Same
 *      pattern the legacy /api/agent/screenshot endpoint uses — the
 *      bucket's general policy is private; only screenshots get
 *      flipped, and the bucket-side lifecycle rule deletes
 *      `screenshots/**` after 30 days.
 *   3. Writes `sites/{siteId}/machines/{machineId}.lastScreenshot = {
 *      url, timestamp, sizeKB }` — the canonical "latest capture"
 *      field the dashboard's ScreenshotDialog subscribes to via
 *      Firestore real-time. Same field the legacy endpoint writes, so
 *      no dashboard changes are needed.
 *   4. Appends a `screenshots/{docId}` history doc and prunes the
 *      subcollection to the most-recent 20 (matching legacy behavior).
 *
 * Why a separate finalize step (rather than letting the upload-url
 * route pre-register everything, or having the agent write Firestore
 * directly)?
 *   - Pre-registering writes a stub lastScreenshot the dashboard would
 *     briefly render before the upload completes.
 *   - Agents don't have GCS service-account credentials and can't mint
 *     public URLs or call makePublic().
 *   - A Cloud Function bucket-trigger could do this, but adds latency
 *     and a new infra surface for a one-line action.
 *
 * Auth: same as /screenshots/upload-url — `machine=<id>:write` (api
 * key) or agent ID-token via requireMachineAuthAndScope.
 *
 * Idempotency: not required. The endpoint is naturally idempotent —
 * calling it twice with the same storagePath flips makePublic twice
 * (no-op the second time) and writes lastScreenshot twice (last-writer
 * wins, same data). The history append IS NOT idempotent so the
 * pruning logic absorbs accidental duplicates.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

// Max history docs kept in the `screenshots` subcollection. Matches the
// MAX_HISTORY constant in the legacy /api/agent/screenshot route so the
// dashboard's sidebar behavior stays the same across the patch window.
const MAX_HISTORY = 20;

// Hard cap on the agent-reported size — the actual file size in storage
// is the source of truth (we read it back via metadata below), but we
// reject obviously-bogus values up front to bound writes.
const MAX_SIZE_KB = 10_240; // 10 MB

interface FinalizeBody {
  storagePath?: unknown;
  sizeKB?: unknown;
  monitor?: unknown;
  contentType?: unknown;
}

function resolveBucketName(): string {
  const explicit =
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    process.env.FIREBASE_STORAGE_BUCKET;
  if (!explicit || explicit.length === 0) {
    throw new Error(
      '[screenshots/finalize] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured',
    );
  }
  return explicit;
}

/**
 * Confirm `storagePath` is shaped like `screenshots/{siteId}/{machineId}/...`
 * with exact match on siteId + machineId. The signed-URL route already
 * generates paths in this shape; this is a server-side reassertion so
 * the agent can't finalize an arbitrary path under another machine.
 */
function validateStoragePath(
  storagePath: string,
  siteId: string,
  machineId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!storagePath.startsWith('screenshots/')) {
    return { ok: false, reason: 'storagePath must start with screenshots/' };
  }
  // Reject path traversal — Firebase Storage tolerates `..` segments but
  // we have no reason to allow them.
  if (storagePath.includes('..')) {
    return { ok: false, reason: 'storagePath must not contain ".."' };
  }
  const segments = storagePath.split('/');
  // segments[0]='screenshots', segments[1]=siteId, segments[2]=machineId,
  // segments[3+]=timestamped filename(s)
  if (segments.length < 4) {
    return {
      ok: false,
      reason: 'storagePath must be screenshots/{site}/{machine}/{name}',
    };
  }
  if (segments[1] !== siteId) {
    return {
      ok: false,
      reason: `storagePath site segment '${segments[1]}' does not match URL siteId`,
    };
  }
  if (segments[2] !== machineId) {
    return {
      ok: false,
      reason: `storagePath machine segment '${segments[2]}' does not match URL machineId`,
    };
  }
  return { ok: true };
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const auth = await requireMachineAuthAndScope(
      request,
      siteId,
      machineId,
      'write',
    );
    if (!auth.ok) return auth.response;

    let body: FinalizeBody;
    try {
      body = (await request.json()) as FinalizeBody;
    } catch {
      return problemValidation('request body is not valid json');
    }
    if (!body || typeof body !== 'object') {
      return problemValidation('request body must be a json object');
    }

    if (typeof body.storagePath !== 'string' || body.storagePath.length === 0) {
      return problemValidation('storagePath is required (string)', {
        'body.storagePath': ['must be a non-empty string'],
      });
    }
    const pathCheck = validateStoragePath(body.storagePath, siteId, machineId);
    if (!pathCheck.ok) {
      return problemValidation(pathCheck.reason, {
        'body.storagePath': [pathCheck.reason],
      });
    }

    const agentSizeKB =
      typeof body.sizeKB === 'number' && Number.isFinite(body.sizeKB)
        ? Math.max(0, Math.round(body.sizeKB))
        : 0;
    if (agentSizeKB > MAX_SIZE_KB) {
      return problemValidation(
        `sizeKB ${agentSizeKB} exceeds max ${MAX_SIZE_KB}`,
        { 'body.sizeKB': [`must be <= ${MAX_SIZE_KB}`] },
      );
    }

    const monitor =
      typeof body.monitor === 'number' && Number.isFinite(body.monitor)
        ? Math.max(0, Math.round(body.monitor))
        : 0;

    let contentType = 'image/jpeg';
    if (body.contentType !== undefined && body.contentType !== null) {
      if (
        typeof body.contentType !== 'string' ||
        !ALLOWED_CONTENT_TYPES.has(body.contentType)
      ) {
        return problemValidation(
          'contentType must be image/png or image/jpeg when provided',
          { 'body.contentType': ['must be image/png or image/jpeg'] },
        );
      }
      contentType = body.contentType;
    }

    const storage = getAdminStorage();
    const bucket = storage.bucket(resolveBucketName());
    const file = bucket.file(body.storagePath);

    // Verify the object actually landed. The agent's PUT could have
    // failed silently (network hiccup absorbed by retries) or the
    // signed URL could have expired between issuance and use — both
    // would leave us with a finalize call against a missing object.
    const [exists] = await file.exists();
    if (!exists) {
      return problemNotFound(
        'storage object not found at storagePath — upload likely never completed',
      );
    }

    // Pin the content-type metadata server-side. The signed-URL upload
    // already had a content-type binding, but the legacy /api/agent/
    // screenshot path uses setMetadata so we mirror that for consistent
    // CDN/browser handling on the public URL we're about to issue.
    await file.setMetadata({
      contentType,
      cacheControl: 'public, max-age=60',
      metadata: {
        machineId,
        siteId,
        capturedAt: String(Date.now()),
      },
    });

    // Authoritative size from the object's metadata (the agent's
    // reported size is advisory; we trust the bucket).
    const [meta] = await file.getMetadata();
    const objectSizeBytes =
      typeof meta.size === 'string'
        ? Number.parseInt(meta.size, 10)
        : typeof meta.size === 'number'
          ? meta.size
          : 0;
    const sizeKB = Math.max(
      1,
      Math.round((Number.isFinite(objectSizeBytes) ? objectSizeBytes : 0) / 1024),
    );

    // Flip to public-read so the dashboard can render via a plain
    // https://storage.googleapis.com/<bucket>/<path> URL without a
    // signed-URL roundtrip on every poll.
    await file.makePublic();

    // Cache-buster ensures browsers fetch the freshest capture even
    // when two captures hash-collide somehow (storagePath includes a
    // random suffix today, so identical paths are vanishingly rare).
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${body.storagePath}?t=${Date.now()}`;

    const db = getAdminDb();
    const machineRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId);

    await machineRef.set(
      {
        lastScreenshot: {
          url: publicUrl,
          timestamp: FieldValue.serverTimestamp(),
          sizeKB,
        },
      },
      { merge: true },
    );

    // History feed for the screenshot-dialog sidebar.
    const screenshotsCol = machineRef.collection('screenshots');
    await screenshotsCol.add({
      url: publicUrl,
      timestamp: FieldValue.serverTimestamp(),
      sizeKB,
      monitor,
    });

    // Prune to MAX_HISTORY, deleting BOTH the Firestore doc AND the
    // storage object (otherwise the bucket accumulates files until the
    // 30-day lifecycle rule sweeps them). Matches legacy endpoint
    // pruning behavior.
    const allDocs = await screenshotsCol.orderBy('timestamp', 'asc').get();
    if (allDocs.size > MAX_HISTORY) {
      const toDelete = allDocs.docs.slice(0, allDocs.size - MAX_HISTORY);
      for (const docSnap of toDelete) {
        const data = docSnap.data();
        try {
          // The stored url includes the cache-buster ?t=... and the
          // storage prefix — extract the bucket-relative path.
          const rawUrl = typeof data.url === 'string' ? data.url : '';
          const prefix = `${bucket.name}/`;
          const pathStart = rawUrl.indexOf(prefix);
          if (pathStart !== -1) {
            const tail = rawUrl.slice(pathStart + prefix.length);
            const qIdx = tail.indexOf('?');
            const oldPath = qIdx === -1 ? tail : tail.slice(0, qIdx);
            if (oldPath) {
              await bucket.file(oldPath).delete().catch(() => {
                // Object may already be gone (manual delete, lifecycle
                // rule, etc.) — pruning is best-effort.
              });
            }
          }
        } catch {
          /* swallow — pruning is best-effort */
        }
        await docSnap.ref.delete();
      }
      console.log(
        `[screenshots/finalize] pruned ${toDelete.length} old screenshots for ${machineId}`,
      );
    }

    console.log(
      `[screenshots/finalize] ${machineId} (${sizeKB}KB, monitor=${monitor}) → ${body.storagePath}`,
    );

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: {
          url: publicUrl,
          storagePath: body.storagePath,
          sizeKB,
          monitor,
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/screenshots/finalize:POST',
    );
  }
}
