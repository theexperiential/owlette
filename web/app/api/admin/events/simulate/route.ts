import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getSiteAlertEmailsWithCc } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS } from '@/lib/emailTemplates.server';
import { fireWebhooks } from '@/lib/webhookSender.server';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

/**
 * POST /api/admin/events/simulate
 *
 * Simulate an event as if it came from an agent. Triggers the same alert/webhook
 * pipeline without requiring a real machine. For testing only.
 *
 * Request body:
 *   siteId: string
 *   event: string           — Event type: "process_crash", "machine_offline", "connection_failure"
 *   data?: {
 *     machineId?: string    — Machine ID (default: "test-machine")
 *     machineName?: string  — Display name (default: "Test Machine")
 *     processName?: string  — For process events
 *     errorMessage?: string — Error details
 *   }
 *
 * Response:
 *   { success: true, event, emailSent: boolean, webhooksFired: number }
 */

const SUPPORTED_EVENTS = ['process_crash', 'machine_offline', 'connection_failure'];

function buildSimulatedAlertEmail(
  event: string,
  siteName: string,
  machineId: string,
  machineName: string,
  processName: string | undefined,
  errorMessage: string
): { subject: string; html: string } {
  const simBadge = `<span style="display:inline-block;background:${EMAIL_COLORS.amber};color:${EMAIL_COLORS.bodyBg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;margin-left:8px;vertical-align:middle;">SIMULATED</span>`;

  const eventTitles: Record<string, string> = {
    process_crash: `process crashed: ${processName}`,
    machine_offline: `machine offline: ${machineName}`,
    connection_failure: 'connection failure',
  };

  const eventSubjects: Record<string, string> = {
    process_crash: `[${ENV_LABEL}] [SIMULATED] process crashed: ${processName} on ${machineName}`,
    machine_offline: `[${ENV_LABEL}] [SIMULATED] machine offline: ${machineName}`,
    connection_failure: `[${ENV_LABEL}] [SIMULATED] connection failure on ${machineName}`,
  };

  const rows = [
    { label: 'site', value: siteName },
    { label: 'machine', value: `${machineName} (${machineId})` },
    ...(processName ? [{ label: 'process', value: processName }] : []),
    { label: 'error', value: errorMessage },
    { label: 'time', value: emailTimestamp() },
    { label: 'environment', value: ENV_LABEL },
  ];

  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">${eventTitles[event] || event} ${simBadge}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a simulated ${event.replace(/_/g, ' ')} event was triggered via the admin API.</p>
    ${emailDataTable(rows)}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.amber};font-size:13px;">this is a simulated event — no real resources were affected.</p>
  `;

  return {
    subject: eventSubjects[event] || `[${ENV_LABEL}] [SIMULATED] ${event} on ${machineName}`,
    html: wrapEmailLayout(content),
  };
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);
      const body = await request.json();
      const { siteId, event, data } = body;

      if (!siteId || !event) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, event' },
          { status: 400 }
        );
      }

      if (!SUPPORTED_EVENTS.includes(event)) {
        return NextResponse.json(
          { error: `Unsupported event type. Supported: ${SUPPORTED_EVENTS.join(', ')}` },
          { status: 400 }
        );
      }

      const { siteData } = await assertUserHasSiteAccess(userId, siteId);
      const siteName = (siteData as Record<string, unknown>)?.name as string || siteId;

      const machineId = data?.machineId || 'test-machine';
      const machineName = data?.machineName || 'Test Machine';
      const processName = data?.processName;
      const errorMessage = data?.errorMessage || 'Simulated error';

      if (event === 'process_crash' && !processName) {
        return NextResponse.json(
          { error: 'Missing data.processName for process_crash event' },
          { status: 400 }
        );
      }

      // Check Resend is configured
      const resendClient = getResend();
      if (!resendClient) {
        logger.warn('RESEND_API_KEY not configured — simulated alert not sent', { context: 'admin/events/simulate' });
        return NextResponse.json({
          success: true,
          event,
          emailSent: false,
          webhooksFired: 0,
          reason: 'Resend not configured',
        });
      }

      // Get recipient emails based on event type
      const { to: recipients, cc } = await getSiteAlertEmailsWithCc(
        siteId,
        event === 'process_crash' ? 'processAlerts' : 'healthAlerts'
      );

      if (recipients.length === 0) {
        logger.warn(`No recipients found for site ${siteId}`, { context: 'admin/events/simulate' });
        return NextResponse.json({
          success: true,
          event,
          emailSent: false,
          webhooksFired: 0,
          reason: 'No recipients',
        });
      }

      // Build and send email
      const { subject, html } = buildSimulatedAlertEmail(
        event,
        siteName,
        machineId,
        machineName,
        processName,
        errorMessage
      );

      const result = await resendClient.emails.send({
        from: FROM_EMAIL,
        to: recipients,
        ...(cc.length > 0 ? { cc } : {}),
        subject,
        html,
      });

      if (result.error) {
        console.error('[admin/events/simulate] Resend error:', result.error);
        return NextResponse.json({ error: 'Email delivery failed' }, { status: 500 });
      }

      logger.info(`Simulated ${event} for site ${siteId} by user ${userId}`, { context: 'admin/events/simulate' });

      // Fire webhooks
      const webhookEvent = event === 'process_crash' ? 'process.crashed' : 'machine.offline';
      let webhooksFired = 0;
      try {
        webhooksFired = await fireWebhooks(siteId, siteName, webhookEvent, {
          machine: { id: machineId, name: machineName },
          ...(processName ? { process: { name: processName, error: errorMessage } } : {}),
        });
      } catch (e) {
        console.error('[admin/events/simulate] Webhook error:', e);
      }

      return NextResponse.json({
        success: true,
        event,
        emailSent: true,
        recipients,
        webhooksFired,
      });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/events/simulate');
    }
  },
  { strategy: 'agentAlert', identifier: 'ip' }
);
