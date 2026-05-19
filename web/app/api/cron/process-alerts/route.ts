import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { wrapEmailLayout, EMAIL_COLORS, emailTimestamp } from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/cron/process-alerts
 *
 * Railway HTTP cron endpoint that drains the pending_process_alerts queue
 * and sends batched digest emails grouped by site.
 *
 * Alerts are held for ACCUMULATION_WINDOW_MS before sending, allowing
 * multiple machines that crash around the same time to be grouped into
 * a single email per site.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * Railway cron config (set in Railway dashboard):
 *   Schedule:  * /3 * * * *   (every 3 minutes)
 *   URL:       GET https://<your-app>/api/cron/process-alerts
 *   Header:    X-Cron-Secret: <CRON_SECRET value>
 */

// Only process alerts older than this to allow accumulation
const ACCUMULATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

interface PendingAlert {
  docId: string;
  siteId: string;
  machineId: string;
  processName: string;
  errorMessage: string;
  agentVersion: string;
  eventType: string;
  timestamp: FirebaseFirestore.Timestamp;
}

function buildProcessDigestEmail(
  siteId: string,
  alerts: PendingAlert[],
  unsubscribeUrl?: string,
  timezone?: string,
): string {
  // Single alert: use a simpler layout matching the old single-process email
  if (alerts.length === 1) {
    const a = alerts[0];
    const eventLabel = a.eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
    const content = `
      <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process ${eventLabel}: ${a.processName}</h2>
      <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a monitored process has ${eventLabel} on one of your machines.</p>
      <table width="100%" style="border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${alertRow('site', siteId, false)}
        ${alertRow('machine', a.machineId, true)}
        ${alertRow('process', a.processName, false)}
        ${alertRow('event', eventLabel, true, EMAIL_COLORS.red)}
        ${alertRow('error', a.errorMessage, false)}
        ${alertRow('agent version', a.agentVersion, true)}
        ${alertRow('time', emailTimestamp(a.timestamp?.toDate?.() ?? new Date(), timezone), false)}
      </table>
      <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
    `;
    return wrapEmailLayout(content, {
      preheader: `process ${eventLabel}: ${a.processName} on ${a.machineId}`,
      unsubscribeUrl,
    });
  }

  // Multiple alerts: digest table
  const rows = alerts
    .map((a, i) => {
      const eventLabel = a.eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
      const bg = i % 2 === 1 ? `background:${EMAIL_COLORS.altRow};` : '';
      return `
      <tr>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${a.machineId}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${a.processName}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.red};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${eventLabel}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${a.errorMessage}</td>
      </tr>`;
    })
    .join('');

  const thStyle = `padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};`;

  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process alerts: ${alerts.length} event(s)</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">${alerts.length} process event(s) detected in site <strong style="color:${EMAIL_COLORS.text};">${siteId}</strong>.</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="${thStyle}">machine</th>
          <th style="${thStyle}">process</th>
          <th style="${thStyle}">event</th>
          <th style="${thStyle}">error</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check each machine and verify that processes are running correctly.</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">checked at ${emailTimestamp(new Date(), timezone)}</p>
  `;

  return wrapEmailLayout(content, {
    preheader: `${alerts.length} process event(s) in ${siteId}`,
    unsubscribeUrl,
  });
}

/** Simple key-value row for single-alert emails (matches emailDataTable style). */
function alertRow(label: string, value: string, alt: boolean, highlight?: string): string {
  const bg = alt ? `background:${EMAIL_COLORS.altRow};` : '';
  const color = highlight || EMAIL_COLORS.text;
  return `
    <tr>
      <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};font-size:13px;font-weight:600;white-space:nowrap;border-bottom:1px solid ${EMAIL_COLORS.border};width:140px;">${label}</td>
      <td style="padding:10px 14px;${bg}color:${color};font-size:13px;border-bottom:1px solid ${EMAIL_COLORS.border};">${value}</td>
    </tr>`;
}

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
      .collection('pending_process_alerts')
      .where('timestamp', '<=', cutoff)
      .get();

    if (alertsSnap.empty) {
      return NextResponse.json({ ok: true, alertsProcessed: 0 });
    }

    // Parse alerts
    const alerts: PendingAlert[] = alertsSnap.docs.map(doc => ({
      docId: doc.id,
      ...(doc.data() as Omit<PendingAlert, 'docId'>),
    }));

    // Group by siteId
    const alertsBySite = new Map<string, PendingAlert[]>();
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
        const recipients = await getSiteAlertRecipients(siteId, 'processAlerts');
        if (recipients.length === 0) {
          console.warn(`[cron/process-alerts] No recipients for site ${siteId}`);
          continue;
        }

        if (!resendClient) {
          console.warn('[cron/process-alerts] Resend not configured — skipping');
          continue;
        }

        // Get timezone from the first machine for display
        const tz = await getMachineTimezone(siteId, siteAlerts[0].machineId);

        // Send per-recipient emails (for individual unsubscribe links)
        for (const recipient of recipients) {
          try {
            // Filter out alerts for machines this user has muted
            const userAlerts = siteAlerts.filter(a => !recipient.mutedMachines.includes(a.machineId));
            if (userAlerts.length === 0) continue;

            const unsubscribeUrl = recipient.userId !== 'fallback'
              ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
              : undefined;

            // Rebuild subject for this user's filtered alerts
            const userSubject = userAlerts.length === 1
              ? `Process ${userAlerts[0].eventType === 'process_start_failed' ? 'failed to start' : 'crashed'}: ${userAlerts[0].processName} on ${userAlerts[0].machineId}`
              : `${userAlerts.length} process event(s) in ${siteId}`;

            const html = buildProcessDigestEmail(siteId, userAlerts, unsubscribeUrl, tz);

            const result = await resendClient.emails.send({
              from: FROM_EMAIL,
              to: [recipient.email],
              ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
              subject: userSubject,
              html,
            });

            if (result.error) {
              console.error(`[cron/process-alerts] Resend error for ${recipient.email}:`, result.error);
            } else {
              emailsSent++;
            }
          } catch (emailError) {
            console.error(`[cron/process-alerts] Failed to send to ${recipient.email}:`, emailError);
          }
        }

        console.log(
          `[cron/process-alerts] Digest sent for site ${siteId}: ` +
          `${siteAlerts.length} event(s), ${recipients.length} recipient(s)`
        );
      } catch (error) {
        console.error(`[cron/process-alerts] Failed for site ${siteId}:`, error);
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
    return apiError(error, 'cron/process-alerts');
  }
}
