import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import {
  buildDisplayDigestEmail,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/cron/display-alerts
 *
 * Railway HTTP cron endpoint that drains the `pending_display_alerts` queue
 * and sends batched digest emails grouped by site.
 *
 * Alerts are held for ACCUMULATION_WINDOW_MS before being sent, allowing a
 * burst of related events (e.g. a video-wall power blip emitting 8 drift
 * events + 1 monitor_removed in the same minute) to be grouped into a
 * single email per site instead of an inbox-flooding cascade.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * Railway cron config (set in Railway dashboard):
 *   Schedule:  * /3 * * * *   (every 3 minutes — matches process-alerts)
 *   URL:       GET https://<your-app>/api/cron/display-alerts
 *   Header:    X-Cron-Secret: <CRON_SECRET value>
 *
 * Critical-path bypass: `display_monitor_removed` and
 * `display_auto_revert_fired` skip this digest entirely and email
 * immediately via the inline-send path in `/api/agent/alert` (B3.3) so the
 * operator gets a sub-minute alert. Everything else routes through here.
 */

// Only process alerts older than this so a burst can accumulate into one
// digest entry. Matches the process-alerts cadence.
const ACCUMULATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export async function GET(request: NextRequest) {
  // Validate cron secret
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const cutoff = new Date(Date.now() - ACCUMULATION_WINDOW_MS);

  try {
    // Query alerts older than the accumulation window
    const alertsSnap = await db
      .collection('pending_display_alerts')
      .where('timestamp', '<=', cutoff)
      .get();

    if (alertsSnap.empty) {
      return NextResponse.json({ ok: true, alertsProcessed: 0 });
    }

    // Parse alerts
    const alerts: PendingDisplayAlert[] = alertsSnap.docs.map((doc) => {
      const raw = doc.data() as Omit<PendingDisplayAlert, 'docId'>;
      return {
        docId: doc.id,
        ...raw,
      };
    });

    // Group by siteId
    const alertsBySite = new Map<string, PendingDisplayAlert[]>();
    for (const alert of alerts) {
      const existing = alertsBySite.get(alert.siteId) ?? [];
      existing.push(alert);
      alertsBySite.set(alert.siteId, existing);
    }

    const resendClient = getResend();
    const baseUrl = request.nextUrl.origin;
    let emailsSent = 0;

    for (const [siteId, siteAlerts] of alertsBySite) {
      try {
        // Filter recipients on the `displayAlerts` opt-out preference (B1.4
        // extended the union). Users who opted out get no digest, even
        // though their queue entries get drained alongside everyone else's.
        const recipients = await getSiteAlertRecipients(siteId, 'displayAlerts');
        if (recipients.length === 0) {
          console.warn(`[cron/display-alerts] No recipients for site ${siteId}`);
          continue;
        }

        if (!resendClient) {
          console.warn('[cron/display-alerts] Resend not configured — skipping');
          continue;
        }

        // Get timezone from the first machine for display
        const tz = await getMachineTimezone(siteId, siteAlerts[0].machineId);

        // Send per-recipient emails (for individual unsubscribe links)
        for (const recipient of recipients) {
          try {
            // Per-user `mutedMachines` filter — drops alerts for machines
            // this user has explicitly muted. Empty result = nothing to
            // email this user, skip the whole send.
            const userAlerts = siteAlerts.filter(
              (a) => !recipient.mutedMachines.includes(a.machineId),
            );
            if (userAlerts.length === 0) continue;

            const unsubscribeUrl = recipient.userId !== 'fallback'
              ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
              : undefined;

            // Subject: collapse to a focused single-event subject when
            // there's just one alert in this user's filtered set, otherwise
            // give the count + site for fast inbox triage.
            const userSubject = userAlerts.length === 1
              ? `[owlette] display event on ${userAlerts[0].machineId}`
              : `[owlette] ${userAlerts.length} display event(s) in ${siteId}`;

            const html = buildDisplayDigestEmail(siteId, userAlerts, unsubscribeUrl, tz);

            const result = await resendClient.emails.send({
              from: FROM_EMAIL,
              to: [recipient.email],
              ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
              subject: userSubject,
              html,
            });

            if (result.error) {
              console.error(`[cron/display-alerts] Resend error for ${recipient.email}:`, result.error);
            } else {
              emailsSent++;
            }
          } catch (emailError) {
            console.error(`[cron/display-alerts] Failed to send to ${recipient.email}:`, emailError);
          }
        }

        console.log(
          `[cron/display-alerts] Digest sent for site ${siteId}: ` +
          `${siteAlerts.length} event(s), ${recipients.length} recipient(s)`,
        );
      } catch (error) {
        console.error(`[cron/display-alerts] Failed for site ${siteId}:`, error);
      }
    }

    // Delete all processed alerts (Firestore batch limit: 500)
    const docs = alertsSnap.docs;
    for (let i = 0; i < docs.length; i += 500) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + 500)) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }

    return NextResponse.json({
      ok: true,
      alertsProcessed: alerts.length,
      emailsSent,
      sites: alertsBySite.size,
    });
  } catch (error) {
    return apiError(error, 'cron/display-alerts');
  }
}
