/**
 * GET /api/cron/billing-trial-lifecycle (billing-system wave 2.2)
 *
 * Daily sweep that moves the app-managed 14-day trial forward for every
 * `customers/{uid}` doc:
 *
 *   1. re-mirrors `billingState` from `resolveBillingState()` — which is what
 *      flips an unconverted account to `'expired'` once its clock runs out;
 *   2. sends the three trial notices (day 10 "4 days left", day 13
 *      "tomorrow", expiry "pick a plan to reactivate"), exactly once each;
 *   3. stamps `alertEmailsDisabledAt` 30 days after expiry, which is what
 *      finally stops machine-offline alert emails for a dead account
 *      (consulted in `/api/cron/health-check`).
 *
 * All of the decision-making lives in `@/lib/billing/trialLifecycle.server`
 * so the milestone matrix is unit-testable without a request. This file is
 * the auth shell and the summary shape, nothing more.
 *
 * Authentication: `X-Cron-Secret` must match `CRON_SECRET`, same as the other
 * five cron endpoints. Deliberately not in the public OpenAPI spec (see
 * `scripts/validate-openapi.ts` → `INTERNAL_ROUTES`).
 *
 * Schedule: once a day on cron-job.org. Cadence, not clock precision, is what
 * matters — milestones are "due at or after this instant", so a late or
 * skipped run catches up on the next pass and never re-sends or back-sends
 * (an account first swept a month late gets "your trial ended", not a backlog
 * ending in "4 days left"). Registering the job is a ship-time step; it does
 * not happen automatically on deploy.
 *
 * Partial-failure tolerant: one malformed customers doc, missing user, or
 * rejected send costs that account only and is reported in `errors`. Only a
 * failure to page the collection reaches the 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runTrialLifecycle } from '@/lib/billing/trialLifecycle.server';

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runTrialLifecycle();

    console.log(
      `[cron/billing-trial-lifecycle] processed=${summary.processed} ` +
        `expired=${summary.expired} ` +
        `emails=${summary.emailsSent.day10}/${summary.emailsSent.day13}/${summary.emailsSent.expired} ` +
        `alertCutoffs=${summary.alertCutoffs} errors=${summary.errors}`
    );

    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error('[cron/billing-trial-lifecycle] failed:', error);
    return NextResponse.json({ error: 'Trial lifecycle sweep failed' }, { status: 500 });
  }
}
