import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedLegacyBodySiteHandler } from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertEmailsWithCc, getSiteAlertRecipients } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import {
  wrapEmailLayout,
  emailDataTable,
  emailTimestamp,
  EMAIL_COLORS,
  buildDisplayDigestEmail,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';
import { fireWebhooks } from '@/lib/webhookSender.server';
import {
  DISPLAY_EVENT_ROUTING,
  isDisplayEventType,
} from '@/lib/alerts/displayEventRouting';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
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
 *   event: string           — Event type. One of:
 *     - process: "process_crash"
 *     - connection: "machine_offline", "connection_failure"
 *     - display: any key in DISPLAY_EVENT_ROUTING (10 events)
 *   data?: {
 *     machineId?: string         — Machine ID (default: "test-machine")
 *     machineName?: string       — Display name (default: "Test Machine")
 *     processName?: string       — For process events
 *     errorMessage?: string      — Error details
 *     applyId?: string           — Display: source apply that triggered this event
 *     correlatedApplyId?: string — Display: apply correlated with this event (drift / auto-revert)
 *     monitor?: { friendlyName?, id?, port?, edidHash? }  — Display: subject monitor
 *     changes?: string[]         — Display: drift change list (e.g. ["resolution.width"])
 *   }
 *
 * Response:
 *   { success: true, event, emailSent: boolean, webhooksFired: number }
 */

const NON_DISPLAY_EVENTS = ['process_crash', 'machine_offline', 'connection_failure'] as const;
const DISPLAY_EVENTS = Object.keys(DISPLAY_EVENT_ROUTING);
const SUPPORTED_EVENTS = [...NON_DISPLAY_EVENTS, ...DISPLAY_EVENTS];

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

/**
 * Simulate a display event by mirroring the agent-side dispatch in
 * `/api/agent/alert`. Both critical-path and digest-routed display emails
 * are sent inline here (rather than queued to `pending_display_alerts`) so
 * admins see the email + webhook output synchronously — the digest cadence
 * isn't useful in a preview context. Layout still flows through
 * `buildDisplayDigestEmail` so what admins preview matches the real cron
 * output exactly.
 */
async function simulateDisplayEvent(params: {
  request: NextRequest;
  event: string;
  siteId: string;
  siteName: string;
  machineId: string;
  machineName: string;
  data: Record<string, unknown>;
}): Promise<NextResponse> {
  const { request, event, siteId, siteName, machineId, machineName, data } = params;
  const route = DISPLAY_EVENT_ROUTING[event];

  // Pull through the optional fields the routing table's downstream
  // consumers (webhookSender extractFields, emailTemplates displayEventDetail)
  // expect, so a simulated event renders identically to a real one.
  const displayData: Record<string, unknown> = {
    machine: { id: machineId, name: machineName },
    ...(typeof data.applyId === 'string' ? { applyId: data.applyId } : {}),
    ...(data.monitor && typeof data.monitor === 'object' ? { monitor: data.monitor } : {}),
    ...(Array.isArray(data.changes) ? { changes: data.changes } : {}),
    simulated: true,
  };
  const correlatedApplyId =
    typeof data.correlatedApplyId === 'string' ? data.correlatedApplyId : '';

  // --- Email path (inline for simulator) ---
  let emailsSent = 0;
  let emailSkippedReason: string | undefined;
  if (route.email) {
    const resendClient = getResend();
    if (!resendClient) {
      emailSkippedReason = 'Resend not configured';
      logger.warn('RESEND_API_KEY not configured — simulated display alert not sent', {
        context: 'admin/events/simulate',
      });
    } else {
      const recipients = await getSiteAlertRecipients(siteId, 'displayAlerts');
      if (recipients.length === 0) {
        emailSkippedReason = 'No recipients';
      } else {
        const alert: PendingDisplayAlert = {
          docId: `sim-${Date.now()}`,
          siteId,
          machineId,
          eventType: event,
          data: displayData,
          agentVersion: 'simulated',
          correlatedApplyId,
          timestamp: new Date(),
        };
        const baseUrl = request.nextUrl.origin;
        const subject = `[${ENV_LABEL}] [SIMULATED] ${event.replace(/_/g, ' ')} on ${machineName}`;

        for (const recipient of recipients) {
          // Mirror the production critical-path send loop: honor mutedMachines
          // so simulated events respect the same operator escape hatch.
          if (recipient.mutedMachines.includes(machineId)) continue;

          const unsubscribeUrl = recipient.userId !== 'fallback'
            ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
            : undefined;
          const html = buildDisplayDigestEmail(siteId, [alert], unsubscribeUrl);

          try {
            const result = await resendClient.emails.send({
              from: FROM_EMAIL,
              to: [recipient.email],
              ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
              subject,
              html,
            });
            if (result.error) {
              console.error(`[admin/events/simulate] Resend error for ${recipient.email}:`, result.error);
            } else {
              emailsSent++;
            }
          } catch (e) {
            console.error(`[admin/events/simulate] Failed to send to ${recipient.email}:`, e);
          }
        }
      }
    }
  }

  // --- Webhook path ---
  let webhooksFired = 0;
  if (route.webhook) {
    try {
      webhooksFired = await fireWebhooks(siteId, siteName, route.webhookEventName, displayData);
    } catch (e) {
      console.error('[admin/events/simulate] Webhook error:', e);
    }
  }

  logger.info(
    `Simulated display ${event} for site ${siteId}: emails=${emailsSent} webhooks=${webhooksFired}`,
    { context: 'admin/events/simulate' },
  );

  return NextResponse.json({
    success: true,
    event,
    emailSent: emailsSent > 0,
    emailsSent,
    webhooksFired,
    criticalPath: !!route.criticalPath,
    routedEmail: route.email,
    routedWebhook: route.webhook,
    ...(emailSkippedReason ? { reason: emailSkippedReason } : {}),
  });
}

export const POST = withRateLimit(
  authorizedLegacyBodySiteHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
    deprecated: true,
    routeName: 'POST /api/admin/events/simulate',
  })(async (request: NextRequest, ctx) => {
    try {
      const body = await request.json();
      const { event, data } = body;
      const siteId = ctx.siteId;
      const userId = ctx.actor.userId;

      if (!event) {
        return NextResponse.json(
          { error: 'Missing required field: event' },
          { status: 400 }
        );
      }

      if (!SUPPORTED_EVENTS.includes(event)) {
        return NextResponse.json(
          { error: `Unsupported event type. Supported: ${SUPPORTED_EVENTS.join(', ')}` },
          { status: 400 }
        );
      }

      const siteDoc = await getAdminDb().collection('sites').doc(siteId).get();
      const siteData = siteDoc.exists ? siteDoc.data() : undefined;
      const siteName = (siteData as Record<string, unknown> | undefined)?.name as string || siteId;

      const machineId = data?.machineId || 'test-machine';
      const machineName = data?.machineName || 'Test Machine';
      const processName = data?.processName;
      const errorMessage = data?.errorMessage || 'Simulated error';

      // --- Display events: route through DISPLAY_EVENT_ROUTING ---
      if (isDisplayEventType(event)) {
        logger.info(`Simulating display ${event} for site ${siteId} by user ${userId}`, {
          context: 'admin/events/simulate',
        });
        return await simulateDisplayEvent({
          request,
          event,
          siteId,
          siteName,
          machineId,
          machineName,
          data: (data && typeof data === 'object') ? (data as Record<string, unknown>) : {},
        });
      }

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
    } catch (error: unknown) {
      return apiError(error, 'admin/events/simulate');
    }
  }),
  { strategy: 'agentAlert', identifier: 'ip' }
);
