import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getSiteAlertEmailsWithCc } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { fireWebhooks } from '@/lib/webhookSender.server';
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
  machineId: string,
  machineName: string,
  processName: string | undefined,
  errorMessage: string
): { subject: string; html: string } {
  const timestamp = new Date().toLocaleString();

  if (event === 'process_crash') {
    return {
      subject: `[${ENV_LABEL}] [SIMULATED] Process crashed: ${processName} on ${machineName}`,
      html: `
        <h2 style="color:#d32f2f;">⚠️ [SIMULATED] Process Crashed: ${processName}</h2>
        <p>A simulated process crash event was triggered via the Admin API.</p>
        <table style="border-collapse:collapse;width:100%;max-width:500px;">
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineName} (${machineId})</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Process</td><td style="padding:6px;">${processName}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Error</td><td style="padding:6px;">${errorMessage}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666;">This is a simulated event — no real process was affected.</p>
        <hr>
        <p style="color:#666;font-size:12px;">This is an automated alert from Owlette (simulated).</p>
      `,
    };
  }

  if (event === 'machine_offline') {
    return {
      subject: `[${ENV_LABEL}] [SIMULATED] Machine offline: ${machineName}`,
      html: `
        <h2 style="color:#d32f2f;">⚠️ [SIMULATED] Machine Offline: ${machineName}</h2>
        <p>A simulated machine offline event was triggered via the Admin API.</p>
        <table style="border-collapse:collapse;width:100%;max-width:500px;">
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineName} (${machineId})</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Error</td><td style="padding:6px;">${errorMessage}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666;">This is a simulated event — no real machine was affected.</p>
        <hr>
        <p style="color:#666;font-size:12px;">This is an automated alert from Owlette (simulated).</p>
      `,
    };
  }

  // connection_failure
  return {
    subject: `[${ENV_LABEL}] [SIMULATED] Connection failure on ${machineName}`,
    html: `
      <h2 style="color:#d32f2f;">⚠️ [SIMULATED] Connection Failure</h2>
      <p>A simulated connection failure event was triggered via the Admin API.</p>
      <table style="border-collapse:collapse;width:100%;max-width:500px;">
        <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineName} (${machineId})</td></tr>
        <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Error</td><td style="padding:6px;">${errorMessage}</td></tr>
        <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
        <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
      </table>
      <p style="margin-top:16px;color:#666;">This is a simulated event — no real machine was affected.</p>
      <hr>
      <p style="color:#666;font-size:12px;">This is an automated alert from Owlette (simulated).</p>
    `,
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
      console.error('admin/events/simulate:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'agentAlert', identifier: 'ip' }
);
