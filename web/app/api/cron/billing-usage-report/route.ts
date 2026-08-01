/**
 * GET /api/cron/billing-usage-report
 *
 * Daily metered-usage report to Stripe (billing-system waves 2.3 + 2.4).
 * Counts each subscribed account's billable machines and its roost storage
 * overage, posts both as Billing Meter events, and mirrors the breakdown
 * into `billing/{uid}/usage/{YYYY-MM-DD}` so the in-app billing tab can
 * render a projected bill without calling Stripe.
 *
 * All of the work — and all of the reasoning about metered-billing
 * semantics, idempotency, and the active-machine definition — lives in
 * `@/lib/billing/usageReport.server`. This file is only the cron edge:
 * authenticate, run, serialise.
 *
 * **Schedule: 03:00 UTC daily, registered on cron-job.org.** Like the other
 * five endpoints here it is a plain authenticated route with no platform-side
 * scheduling attached, so *creating the cron-job.org entry is a manual step*
 * at ship time — until someone does, this route exists and never fires.
 *
 * Deliberately safe to re-run. Hitting it twice in a day does not
 * double-report: the mirror doc records which meters a period already sent,
 * and the meter events themselves carry a deterministic identifier that
 * Stripe dedupes on. That matters here because a cron-job.org retry after a
 * timeout is indistinguishable from a manual re-trigger.
 *
 * Returns 200 with `skipped: 'unconfigured'` when no Stripe key is set —
 * the normal state for the whole pre-go-live window, and a 500 there would
 * page someone every morning for a deployment that is working as intended.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runUsageReport } from '@/lib/billing/usageReport.server';

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runUsageReport();
    return NextResponse.json(summary);
  } catch (error) {
    // Only a fault that took down the whole sweep reaches here — a single
    // account's failure is absorbed and reported in `summary.failures`.
    console.error('[billing-usage-report] failed:', error);
    return NextResponse.json(
      { error: 'Usage report failed' },
      { status: 500 },
    );
  }
}
