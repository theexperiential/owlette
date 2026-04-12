import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { wrapEmailLayout, EMAIL_COLORS, emailTimestamp } from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { fireWebhooks } from '@/lib/webhookSender.server';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/cron/health-check
 *
 * Railway HTTP cron endpoint that scans all machines for stale heartbeats
 * and sends email alerts to site admins when machines appear offline.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * Deduplication: Writes health.lastCronAlertAt to Firestore after sending,
 * preventing repeat emails within ALERT_COOLDOWN_MS (default: 1 hour).
 *
 * Railway cron config (set in Railway dashboard):
 *   Schedule:  * /5 * * * *   (every 5 minutes)
 *   URL:       GET https://<your-app>/api/cron/health-check
 *   Header:    X-Cron-Secret: <CRON_SECRET value>
 */

// A machine is considered offline if its heartbeat is older than this
const OFFLINE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

// Don't re-alert for the same machine within this window
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

interface OfflineAlert {
  siteId: string;
  machineId: string;
  lastHeartbeatMs: number;
  heartbeatAgeMinutes: number;
  timezone?: string;
}

function buildOfflineEmail(siteId: string, alerts: OfflineAlert[], unsubscribeUrl?: string): string {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:10px 14px;color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${a.machineId}</td>
        <td style="padding:10px 14px;color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${a.heartbeatAgeMinutes} minute(s) ago</td>
      </tr>`
    )
    .join('');

  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">machines offline</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">${alerts.length} machine(s) in site <strong style="color:${EMAIL_COLORS.text};">${siteId}</strong> appear to be offline.</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">machine</th>
          <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">last seen</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check each machine and verify that the owlette service is running.</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">checked at ${emailTimestamp(new Date(), alerts[0]?.timezone)}</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">alerts are sent at most once per hour per machine.</p>
  `;

  return wrapEmailLayout(content, {
    unsubscribeUrl,
    preheader: `${alerts.length} machine(s) offline in ${siteId}`,
  });
}

export async function GET(request: NextRequest) {
  // Validate cron secret
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = Date.now();
  const allAlerts: OfflineAlert[] = [];
  let sitesChecked = 0;
  let machinesChecked = 0;

  try {
    const sitesSnap = await db.collection('sites').get();
    sitesChecked = sitesSnap.size;

    for (const siteDoc of sitesSnap.docs) {
      const siteId = siteDoc.id;

      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      machinesChecked += machinesSnap.size;

      for (const machineDoc of machinesSnap.docs) {
        const machine = machineDoc.data();

        // Only alert for machines that were previously online
        if (machine.online !== true) continue;

        const lastHeartbeatMs: number =
          (machine.lastHeartbeat as FirebaseFirestore.Timestamp | null)?.toMillis?.() ?? 0;
        const heartbeatAge = now - lastHeartbeatMs;

        if (heartbeatAge <= OFFLINE_THRESHOLD_MS) continue;

        // Check dedup cooldown
        const lastAlertedMs: number =
          (machine.health?.lastCronAlertAt as FirebaseFirestore.Timestamp | null)?.toMillis?.() ?? 0;

        if (now - lastAlertedMs <= ALERT_COOLDOWN_MS) continue;

        // Mark as alerted to prevent duplicate emails this hour
        await machineDoc.ref.set(
          { health: { lastCronAlertAt: FieldValue.serverTimestamp() } },
          { merge: true }
        );

        allAlerts.push({
          siteId,
          machineId: machineDoc.id,
          lastHeartbeatMs,
          heartbeatAgeMinutes: Math.floor(heartbeatAge / 60000),
          timezone: machine.machine_timezone || undefined,
        });
      }
    }
  } catch (error) {
    return apiError(error, 'cron/health-check');
  }

  if (allAlerts.length === 0) {
    return NextResponse.json({
      ok: true,
      sitesChecked,
      machinesChecked,
      alertsSent: 0,
    });
  }

  // Group alerts by site and send individual emails (each with a personalized unsubscribe link)
  const alertsBySite = new Map<string, OfflineAlert[]>();
  for (const alert of allAlerts) {
    const existing = alertsBySite.get(alert.siteId) ?? [];
    existing.push(alert);
    alertsBySite.set(alert.siteId, existing);
  }

  const resendClient = getResend();
  const baseUrl = request.nextUrl.origin;
  let alertsSent = 0;

  for (const [siteId, siteAlerts] of alertsBySite) {
    try {
      const recipients = await getSiteAlertRecipients(siteId, 'healthAlerts');
      if (recipients.length === 0) {
        console.warn(`[cron/health-check] No recipients for site ${siteId}`);
        continue;
      }

      if (!resendClient) {
        console.warn('[cron/health-check] Resend not configured — skipping email');
        continue;
      }

      // Send individual emails so each user gets their own unsubscribe link
      for (const recipient of recipients) {
        try {
          // Filter out alerts for machines this user has muted
          const userAlerts = siteAlerts.filter(a => !recipient.mutedMachines.includes(a.machineId));
          if (userAlerts.length === 0) continue;

          const unsubscribeUrl = recipient.userId !== 'fallback'
            ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
            : undefined;

          const result = await resendClient.emails.send({
            from: FROM_EMAIL,
            to: [recipient.email],
            ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
            subject: `${userAlerts.length} machine(s) offline in ${siteId}`,
            html: buildOfflineEmail(siteId, userAlerts, unsubscribeUrl),
          });

          if (result.error) {
            console.error(`[cron/health-check] Resend error for ${recipient.email}:`, result.error);
          } else {
            alertsSent++;
          }
        } catch (emailError) {
          console.error(`[cron/health-check] Failed to send to ${recipient.email}:`, emailError);
        }
      }

      console.log(
        `[cron/health-check] Alert sent for site ${siteId}: ` +
          `${siteAlerts.length} machine(s) offline, ${recipients.length} recipient(s)`
      );

      // Fire webhooks for each offline machine (non-blocking)
      const siteDoc = await db.collection('sites').doc(siteId).get();
      const siteName = siteDoc.data()?.name || siteId;
      for (const alert of siteAlerts) {
        fireWebhooks(siteId, siteName, 'machine.offline', {
          machine: { id: alert.machineId, name: alert.machineId, lastSeen: new Date(alert.lastHeartbeatMs).toISOString() },
        }).catch(console.error);
      }
    } catch (error) {
      console.error(`[cron/health-check] Failed to send alert for site ${siteId}:`, error);
    }
  }

  return NextResponse.json({
    ok: true,
    sitesChecked,
    machinesChecked,
    offlineMachines: allAlerts.length,
    alertsSent,
  });
}
