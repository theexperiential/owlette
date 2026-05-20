/**
 * GET /api/health
 *     → Readiness probe for the cloudflare load balancer. Unauthenticated so
 *       the LB can poll it directly. Returns 200 only when this origin can
 *       both serve HTTP and reach firestore with valid credentials; returns
 *       503 otherwise so the LB fails the origin out of rotation.
 *
 * This is intentionally a *readiness* check, not a bare liveness check: the
 * failure mode we care about (an origin that's up but cannot reach its
 * backend — e.g. railway losing egress to google cloud) is invisible to a
 * process-only ping. A shallow firestore read is the cheapest signal that
 * proves end-to-end reachability from this specific origin.
 *
 * Kept deliberately lightweight — a single shallow read with a hard timeout.
 * It does NOT run the full status-page health suite (that's `/api/cron/status-ping`),
 * which would be too slow and would flap the LB on noisy non-critical components.
 */
import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

const FIRESTORE_TIMEOUT_MS = 2_500;

/** Short label for which origin answered — aids debugging via the LB. */
function originLabel(): string {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'railway';
  if (process.env.VERCEL) return `vercel${process.env.VERCEL_REGION ? `:${process.env.VERCEL_REGION}` : ''}`;
  return 'unknown';
}

async function firestoreReachable(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('firestore read timed out')), FIRESTORE_TIMEOUT_MS);
  });

  try {
    // The read succeeding (doc may or may not exist) proves connectivity +
    // valid credentials from this origin. We don't assert existence.
    await Promise.race([
      getAdminDb().collection('system_status').doc('heartbeat').get(),
      timeout,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  const started = Date.now();
  const ok = await firestoreReachable();

  return NextResponse.json(
    {
      ok,
      origin: originLabel(),
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
    },
    {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}
