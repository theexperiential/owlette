import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertEmailsWithCc } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { fireWebhooks } from '@/lib/webhookSender.server';

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
        const { to: recipients, cc } = await getSiteAlertEmailsWithCc(siteId, 'healthAlerts');

        if (recipients.length > 0) {
          const severityLabel = severity.toUpperCase();
          const subject = `[${ENV_LABEL}] [${severityLabel}] ${ruleName} — ${machineId}`;
          const html = buildThresholdAlertEmail({
            machineId,
            ruleName,
            metric,
            value,
            threshold,
            operator,
            severity,
          });

          const result = await resendClient.emails.send({
            from: FROM_EMAIL,
            to: recipients,
            ...(cc.length > 0 ? { cc } : {}),
            subject,
            html,
          });

          if (result.error) {
            console.error('[alerts/trigger] Resend error:', result.error);
          } else {
            emailSent = true;
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
    console.error('[alerts/trigger] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ */
/*  Email template                                                     */
/* ------------------------------------------------------------------ */

const SEVERITY_COLORS: Record<string, string> = {
  info: '#2196F3',
  warning: '#FF9800',
  critical: '#d32f2f',
};

const METRIC_LABELS: Record<string, string> = {
  cpu_percent: 'CPU Usage (%)',
  memory_percent: 'Memory Usage (%)',
  disk_percent: 'Disk Usage (%)',
  gpu_percent: 'GPU Usage (%)',
  cpu_temp: 'CPU Temperature (°C)',
  gpu_temp: 'GPU Temperature (°C)',
  network_latency: 'Network Latency (ms)',
  network_packet_loss: 'Packet Loss (%)',
};

function buildThresholdAlertEmail(params: {
  machineId: string;
  ruleName: string;
  metric: string;
  value: number;
  threshold: number;
  operator: string;
  severity: string;
}): string {
  const { machineId, ruleName, metric, value, threshold, operator, severity } = params;
  const timestamp = new Date().toLocaleString();
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.warning;
  const metricLabel = METRIC_LABELS[metric] || metric;

  return `
    <h2 style="color:${color};">⚠️ Threshold Alert: ${ruleName}</h2>
    <p>A metric threshold has been breached on one of your machines.</p>
    <table style="border-collapse:collapse;width:100%;max-width:500px;">
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineId}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Rule</td><td style="padding:6px;">${ruleName}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Metric</td><td style="padding:6px;">${metricLabel}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Condition</td><td style="padding:6px;">${metricLabel} ${operator} ${threshold}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Current Value</td><td style="padding:6px;color:${color};font-weight:bold;">${value}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Severity</td><td style="padding:6px;">${severity.toUpperCase()}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
    </table>
    <p style="margin-top:16px;">Please check the machine and service metrics for more details.</p>
    <hr>
    <p style="color:#666;font-size:12px;">This is an automated threshold alert from Owlette.</p>
  `;
}
