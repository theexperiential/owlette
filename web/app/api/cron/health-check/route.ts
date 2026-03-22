import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { fireWebhooks } from '@/lib/webhookSender.server';

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
}

function buildOfflineEmail(siteId: string, alerts: OfflineAlert[], unsubscribeUrl?: string): string {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:6px;background:#f5f5f5;">${a.machineId}</td>
        <td style="padding:6px;">${a.heartbeatAgeMinutes} minute(s) ago</td>
      </tr>`
    )
    .join('');

  const unsubscribeHtml = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a> &nbsp;|&nbsp; `
    : '';

  return `
    <h2 style="color:#d32f2f;">Owlette Machines Offline</h2>
    <p>${alerts.length} machine(s) in site <strong>${siteId}</strong> appear to be offline.</p>
    <table style="border-collapse:collapse;width:100%;max-width:500px;">
      <thead>
        <tr>
          <th style="padding:6px;text-align:left;background:#e0e0e0;">Machine</th>
          <th style="padding:6px;text-align:left;background:#e0e0e0;">Last Seen</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;">
      Please check each machine and verify that the Owlette service is running.
    </p>
    <hr>
    <p style="color:#666;font-size:12px;">
      ${unsubscribeHtml}Environment: ${ENV_LABEL} &nbsp;|&nbsp;
      Alerts are sent at most once per hour per machine.
    </p>
  `;
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
        });
      }
    }
  } catch (error) {
    console.error('[cron/health-check] Error scanning machines:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
      const recipients = await getSiteAlertRecipients(siteId);
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
          const unsubscribeUrl = recipient.userId !== 'fallback'
            ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
            : undefined;

          const result = await resendClient.emails.send({
            from: FROM_EMAIL,
            to: [recipient.email],
            ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
            subject: `[${ENV_LABEL}] ${siteAlerts.length} machine(s) offline in ${siteId}`,
            html: buildOfflineEmail(siteId, siteAlerts, unsubscribeUrl),
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
