import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone } from '@/lib/adminUtils.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS, SEVERITY_COLORS, METRIC_LABELS } from '@/lib/emailTemplates.server';
import { fireWebhooks } from '@/lib/webhookSender.server';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * POST /api/alerts/trigger
 *
 * Internal endpoint called by the Cloud Function when a threshold alert rule
 * is breached. Sends email and/or webhook notifications.
 *
 * Authentication: x-internal-secret header matching CORTEX_INTERNAL_SECRET.
 *
 * Request body:
 * - siteId: string
 * - machineId: string
 * - ruleName: string
 * - metric: string
 * - value: number (current metric value)
 * - threshold: number (rule threshold)
 * - operator: string (>, <, >=, <=)
 * - severity: string (info, warning, critical)
 * - channels: string[] (email, webhook)
 */
export async function POST(request: NextRequest) {
  try {
    // Verify internal secret
    const secret = request.headers.get('x-internal-secret');
    const expectedSecret = process.env.CORTEX_INTERNAL_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate body
    const body = await request.json();
    const {
      siteId,
      machineId,
      ruleName,
      metric,
      value,
      threshold,
      operator,
      severity,
      channels,
    } = body;

    if (!siteId || !machineId || !ruleName || !metric || value === undefined || threshold === undefined || !operator || !severity || !Array.isArray(channels)) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const db = getAdminDb();
    let emailSent = false;
    let webhooksFired = 0;

    // Send email notification
    if (channels.includes('email')) {
      const resendClient = getResend();
      if (resendClient) {
        const recipients = await getSiteAlertRecipients(siteId, 'thresholdAlerts');
        const tz = await getMachineTimezone(siteId, machineId);
        const baseUrl = request.nextUrl.origin;

        if (recipients.length > 0) {
          const severityLabel = severity.toUpperCase();
          const subject = `[${severityLabel}] ${ruleName} — ${machineId}`;

          for (const recipient of recipients) {
            // Skip if user has muted this machine
            if (recipient.mutedMachines.includes(machineId)) continue;

            try {
              const unsubscribeUrl = recipient.userId !== 'fallback'
                ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
                : undefined;

              const html = buildThresholdAlertEmail({
                siteId,
                machineId,
                ruleName,
                metric,
                value,
                threshold,
                operator,
                severity,
                unsubscribeUrl,
                timezone: tz,
              });

              const result = await resendClient.emails.send({
                from: FROM_EMAIL,
                to: [recipient.email],
                ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
                subject,
                html,
              });

              if (result.error) {
                console.error(`[alerts/trigger] Resend error for ${recipient.email}:`, result.error);
              } else {
                emailSent = true;
              }
            } catch (emailError) {
              console.error(`[alerts/trigger] Failed to send to ${recipient.email}:`, emailError);
            }
          }

          if (emailSent) {
            console.log(`[alerts/trigger] Email sent to ${recipients.length} recipient(s) for ${ruleName}`);
          }
        }
      } else {
        console.warn('[alerts/trigger] RESEND_API_KEY not configured — email skipped');
      }
    }

    // Fire webhook notifications
    if (channels.includes('webhook')) {
      const siteDoc = await db.collection('sites').doc(siteId).get();
      const siteName = siteDoc.data()?.name || siteId;

      webhooksFired = await fireWebhooks(siteId, siteName, 'threshold.breached', {
        machine: { id: machineId, name: machineId },
        alert: {
          ruleName,
          metric,
          value,
          threshold,
          operator,
          severity,
        },
      });
    }

    console.log(
      `[alerts/trigger] Processed threshold alert: ${ruleName} on ${machineId} ` +
      `(email=${emailSent}, webhooks=${webhooksFired})`
    );

    return NextResponse.json({
      success: true,
      emailSent,
      webhooksFired,
    });
  } catch (error: unknown) {
    return apiError(error, 'alerts/trigger');
  }
}

/* ------------------------------------------------------------------ */
/*  Email template                                                     */
/* ------------------------------------------------------------------ */

function buildThresholdAlertEmail(params: {
  siteId: string;
  machineId: string;
  ruleName: string;
  metric: string;
  value: number;
  threshold: number;
  operator: string;
  severity: string;
  unsubscribeUrl?: string;
  timezone?: string;
}): string {
  const { siteId, machineId, ruleName, metric, value, threshold, operator, severity, unsubscribeUrl, timezone } = params;
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.warning;
  const metricLabel = METRIC_LABELS[metric] || metric;

  const content = `
    <h2 style="color:${color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">threshold alert: ${ruleName}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a metric threshold has been breached on one of your machines.</p>
    ${emailDataTable([
      { label: 'site', value: siteId },
      { label: 'machine', value: machineId },
      { label: 'rule', value: ruleName },
      { label: 'metric', value: metricLabel },
      { label: 'condition', value: `${metricLabel} ${operator} ${threshold}` },
      { label: 'current value', value: String(value), highlight: color },
      { label: 'severity', value: severity.toUpperCase(), highlight: color },
      { label: 'time', value: emailTimestamp(new Date(), timezone) },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service metrics for more details.</p>
  `;
  return wrapEmailLayout(content, { unsubscribeUrl, preheader: `${severity.toUpperCase()}: ${ruleName} on ${machineId}` });
}
