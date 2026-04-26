import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import {
  wrapEmailLayout,
  emailDataTable,
  emailTimestamp,
  EMAIL_COLORS,
  buildDisplayDigestEmail,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { withRateLimit } from '@/lib/withRateLimit';
import {
  checkRateLimit,
  processAlertRateLimit,
  getDisplayAlertRateLimit,
} from '@/lib/rateLimit';
import { fireWebhooks } from '@/lib/webhookSender.server';
import {
  DISPLAY_EVENT_ROUTING,
  isDisplayEventType,
} from '@/lib/alerts/displayEventRouting';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * POST /api/agent/alert
 *
 * Agent-authenticated endpoint to send alert emails when the agent
 * detects a persistent connection failure or a process crash/start failure.
 *
 * Request headers:
 * - Authorization: Bearer <agent-firebase-id-token>
 *
 * Request body:
 * - siteId: string
 * - machineId: string
 * - errorCode: string (for connection_failure)
 * - errorMessage: string
 * - agentVersion: string
 * - eventType: 'connection_failure' | 'process_crash' | 'process_start_failed' (default: 'connection_failure')
 * - processName: string (required for process events)
 *
 * Rate limited: connection failures at 5/hr per IP, process alerts at 3/hr per machineId:processName.
 */


function buildAlertEmail(
  siteId: string,
  machineId: string,
  errorCode: string,
  errorMessage: string,
  agentVersion: string,
  unsubscribeUrl?: string,
  timezone?: string
): string {
  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">agent alert</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">an error was detected on an owlette agent.</p>
    ${emailDataTable([
      { label: 'site', value: siteId },
      { label: 'machine', value: machineId },
      { label: 'error code', value: errorCode },
      { label: 'message', value: errorMessage },
      { label: 'agent version', value: agentVersion },
      { label: 'time', value: emailTimestamp(new Date(), timezone) },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
  `;
  return wrapEmailLayout(content, { unsubscribeUrl });
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      // Verify agent Bearer token
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
      }

      let decodedToken;
      try {
        const adminAuth = getAdminAuth();
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch {
        return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
      }

      // Require agent role
      if (decodedToken.role !== 'agent') {
        return NextResponse.json({ error: 'Forbidden — agent token required' }, { status: 403 });
      }

      // Parse body
      const body = await request.json();
      const { siteId, machineId, errorCode, errorMessage, agentVersion, eventType, processName, data } = body;

      // Determine event type (default to connection_failure for backward compat)
      const resolvedEventType = eventType || 'connection_failure';
      const isProcessEvent = resolvedEventType === 'process_crash' || resolvedEventType === 'process_start_failed';
      // [B3.1] Display events route through `DISPLAY_EVENT_ROUTING` rather
      // than the legacy email-immediate / process-digest branches.
      const isDisplayEvent =
        typeof resolvedEventType === 'string' &&
        resolvedEventType.startsWith('display_') &&
        isDisplayEventType(resolvedEventType);
      const displayData: Record<string, unknown> =
        isDisplayEvent && data && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : {};

      // Validate required fields
      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId' },
          { status: 400 }
        );
      }

      if (!isProcessEvent && !isDisplayEvent && !errorCode) {
        return NextResponse.json(
          { error: 'Missing required field: errorCode (for connection_failure events)' },
          { status: 400 }
        );
      }

      if (isProcessEvent && !processName) {
        return NextResponse.json(
          { error: 'Missing required field: processName (for process events)' },
          { status: 400 }
        );
      }

      // Verify the token's site_id matches the claimed siteId (security check)
      if (decodedToken.site_id && decodedToken.site_id !== siteId) {
        console.warn(
          `[agent/alert] site_id mismatch: token=${decodedToken.site_id}, body=${siteId}`
        );
        return NextResponse.json({ error: 'site_id mismatch' }, { status: 403 });
      }

      // Per-process rate limiting for process events (separate from the IP-based limiter)
      if (isProcessEvent && processAlertRateLimit) {
        const processRateLimitKey = `process_alert:${machineId}:${processName}`;
        const processRateResult = await checkRateLimit(processAlertRateLimit, processRateLimitKey);
        if (!processRateResult.success) {
          console.warn(`[agent/alert] Process alert rate limited: ${processRateLimitKey}`);
          return NextResponse.json({
            success: true,
            emailSent: false,
            reason: 'Process alert rate limited (3/hr per process per machine)',
          });
        }
      }

      const db = getAdminDb();

      // --- Display events (B3.1 + B3.3) ---
      // Routed through `DISPLAY_EVENT_ROUTING`. `suppressAlert === true`
      // (stamped agent-side when the event fires within 90s of a successful
      // apply) skips email entirely but still fires the webhook — receivers
      // handle their own dedupe and the audit trail stays complete.
      // Critical-path events (`route.criticalPath: true` —
      // `display_monitor_removed` / `display_auto_revert_fired`) bypass the
      // 3-min digest and email inline so operators get sub-minute delivery.
      if (isDisplayEvent) {
        const route = DISPLAY_EVENT_ROUTING[resolvedEventType];
        const suppressAlert = displayData.suppressAlert === true;
        const correlatedApplyId =
          typeof displayData.correlatedApplyId === 'string'
            ? displayData.correlatedApplyId
            : '';

        // Per-(machineId, eventType) rate limit — drift gets 4h, others 1h.
        const displayLimiter = getDisplayAlertRateLimit(resolvedEventType);
        if (displayLimiter) {
          const rateLimitKey = `display_alert:${machineId}:${resolvedEventType}`;
          const rateResult = await checkRateLimit(displayLimiter, rateLimitKey);
          if (!rateResult.success) {
            console.warn(
              `[agent/alert] Display alert rate limited: ${rateLimitKey}`,
            );
            return NextResponse.json({
              success: true,
              emailSent: false,
              webhookFired: false,
              reason: 'Display alert rate limited',
            });
          }
        }

        // Email path: critical-path events send inline; everything else
        // queues to the digest cron. Both paths respect suppressAlert + the
        // route.email flag.
        let queuedForEmail = false;
        let immediateEmailsSent = 0;
        if (route.email && !suppressAlert) {
          if (route.criticalPath) {
            immediateEmailsSent = await sendCriticalDisplayEmailNow({
              siteId,
              machineId,
              eventType: resolvedEventType,
              data: displayData,
              agentVersion: agentVersion || '',
              correlatedApplyId,
              baseUrl: request.nextUrl.origin,
            });
          } else {
            await db.collection('pending_display_alerts').add({
              siteId,
              machineId,
              eventType: resolvedEventType,
              data: displayData,
              agentVersion: agentVersion || '',
              correlatedApplyId,
              timestamp: FieldValue.serverTimestamp(),
            });
            queuedForEmail = true;
          }
        }

        // Webhook path: fire immediately (still happens when suppressAlert
        // is set — receivers see the activity even if email is squelched).
        let webhookFired = false;
        if (route.webhook) {
          const siteDoc = await db.collection('sites').doc(siteId).get();
          const siteName = siteDoc.data()?.name || siteId;
          fireWebhooks(siteId, siteName, route.webhookEventName, {
            machine: { id: machineId, name: machineId },
            ...displayData,
          }).catch(console.error);
          webhookFired = true;
        }

        console.log(
          `[agent/alert] Display ${resolvedEventType} on ${machineId} (${siteId}): ` +
          `email=${queuedForEmail ? 'queued' : immediateEmailsSent > 0 ? `inline:${immediateEmailsSent}` : 'no'} ` +
          `webhook=${webhookFired} suppressed=${suppressAlert}`,
        );
        return NextResponse.json({
          success: true,
          emailSent: immediateEmailsSent > 0,
          emailsSent: immediateEmailsSent,
          queued: queuedForEmail,
          webhookFired,
          suppressed: suppressAlert,
          criticalPath: !!route.criticalPath,
        });
      }

      // Determine webhook event type (used by both process and connection paths)
      const webhookEvent = resolvedEventType === 'process_crash' ? 'process.crashed'
        : resolvedEventType === 'process_start_failed' ? 'process.restarted'
        : 'machine.offline';

      // --- Process events: queue for batched digest email ---
      if (isProcessEvent) {
        // Write to pending_process_alerts for batched delivery by cron
        await db.collection('pending_process_alerts').add({
          siteId,
          machineId,
          processName,
          errorMessage: errorMessage || 'Process exited unexpectedly',
          agentVersion: agentVersion || '',
          eventType: resolvedEventType,
          timestamp: FieldValue.serverTimestamp(),
        });

        console.log(`[agent/alert] Queued process alert: ${resolvedEventType} - ${processName} on ${machineId} (${siteId})`);

        // Fire webhooks immediately (non-blocking)
        const siteDoc = await db.collection('sites').doc(siteId).get();
        const siteName = siteDoc.data()?.name || siteId;
        fireWebhooks(siteId, siteName, webhookEvent, {
          machine: { id: machineId, name: machineId },
          process: { name: processName, error: errorMessage || '' },
        }).catch(console.error);

        // Trigger autonomous Cortex investigation immediately (non-blocking)
        const localCortexRunning = await isLocalCortexRunning(db, siteId, machineId);
        if (localCortexRunning) {
          console.log(`[agent/alert] Local Cortex is running on ${machineId} — skipping server-side investigation`);
        } else {
          triggerAutonomousCortex(db, {
            siteId,
            machineId,
            machineName: machineId,
            eventType: resolvedEventType,
            processName: processName || '',
            errorMessage: errorMessage || '',
            agentVersion: agentVersion || '',
          }).catch(err => console.error('[agent/alert] Cortex trigger failed:', err));
        }

        return NextResponse.json({ success: true, queued: true });
      }

      // --- Connection failure events: send email immediately (unchanged) ---
      const resendClient = getResend();
      if (!resendClient) {
        console.warn('[agent/alert] RESEND_API_KEY not configured — alert not sent');
        return NextResponse.json({ success: true, emailSent: false, reason: 'Resend not configured' });
      }

      const [recipients, tz] = await Promise.all([
        getSiteAlertRecipients(siteId, 'healthAlerts'),
        getMachineTimezone(siteId, machineId),
      ]);

      if (recipients.length === 0) {
        console.warn(`[agent/alert] No recipients found for site ${siteId}`);
        return NextResponse.json({ success: true, emailSent: false, reason: 'No recipients' });
      }

      const subject = `[ALERT] owlette agent error on ${machineId}`;
      const baseUrl = request.nextUrl.origin;
      let emailsSent = 0;

      for (const recipient of recipients) {
        try {
          const unsubscribeUrl = recipient.userId !== 'fallback'
            ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
            : undefined;

          const html = buildAlertEmail(siteId, machineId, errorCode, errorMessage || '', agentVersion || '', unsubscribeUrl, tz);

          const result = await resendClient.emails.send({
            from: FROM_EMAIL,
            to: [recipient.email],
            ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
            subject,
            html,
          });

          if (result.error) {
            console.error(`[agent/alert] Resend error for ${recipient.email}:`, result.error);
          } else {
            emailsSent++;
          }
        } catch (emailError) {
          console.error(`[agent/alert] Failed to send to ${recipient.email}:`, emailError);
        }
      }

      console.log(`[agent/alert] Alert sent for ${machineId} (${siteId}): ${resolvedEventType}, ${recipients.length} recipient(s)`);

      // Fire webhooks (non-blocking)
      const siteDoc = await db.collection('sites').doc(siteId).get();
      const siteName = siteDoc.data()?.name || siteId;
      fireWebhooks(siteId, siteName, webhookEvent, {
        machine: { id: machineId, name: machineId },
      }).catch(console.error);

      return NextResponse.json({ success: true, emailSent: emailsSent > 0, recipients: emailsSent });
    } catch (error: unknown) {
      return apiError(error, 'agent/alert');
    }
  },
  { strategy: 'agentAlert', identifier: 'ip' }
);

/**
 * Check if local Cortex is running on a machine (fresh heartbeat within 30s).
 */
async function isLocalCortexRunning(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<boolean> {
  try {
    const machineDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!machineDoc.exists) return false;

    const cortexStatus = machineDoc.data()?.cortexStatus;
    if (!cortexStatus?.online) return false;

    const lastHeartbeat = cortexStatus.lastHeartbeat;
    if (!lastHeartbeat) return false;

    const heartbeatTime = lastHeartbeat.toDate
      ? lastHeartbeat.toDate().getTime()
      : new Date(lastHeartbeat).getTime();

    return Date.now() - heartbeatTime < 30_000;
  } catch {
    return false;
  }
}

/**
 * Trigger autonomous Cortex investigation for a process event.
 * Checks if autonomous mode is enabled, then fires a non-blocking internal request.
 */
async function triggerAutonomousCortex(
  db: FirebaseFirestore.Firestore,
  params: {
    siteId: string;
    machineId: string;
    machineName: string;
    eventType: string;
    processName: string;
    errorMessage: string;
    agentVersion: string;
  }
) {
  const secret = process.env.CORTEX_INTERNAL_SECRET;
  if (!secret) return; // Not configured — autonomous mode unavailable

  // Quick check: is autonomous mode enabled for this site?
  const settingsDoc = await db.doc(`sites/${params.siteId}/settings/cortex`).get();
  if (!settingsDoc.exists || !settingsDoc.data()?.autonomousEnabled) return;

  // Build internal URL for the autonomous endpoint
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // Fire and forget — don't await the response
  fetch(`${baseUrl}/api/cortex/autonomous`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cortex-secret': secret,
    },
    body: JSON.stringify(params),
  }).catch(err => console.error('[agent/alert] Autonomous Cortex request failed:', err));
}

/**
 * [B3.3] Send a single critical-path display alert immediately, bypassing
 * the digest cron. Used by `display_monitor_removed` and
 * `display_auto_revert_fired` — events where minute-scale latency is
 * unacceptable (panel down, apply silently auto-reverted) and the
 * standard digest cadence would let the operator miss them.
 *
 * Uses the same `buildDisplayDigestEmail` helper as the cron path so the
 * single-event email layout is identical regardless of which path emitted
 * it. Per-recipient send loop honors `mutedMachines` + emits individual
 * unsubscribe links the same way the digest cron does.
 *
 * Returns the count of emails actually sent (after Resend failures) so
 * the caller can include it in the response payload.
 */
async function sendCriticalDisplayEmailNow(params: {
  siteId: string;
  machineId: string;
  eventType: string;
  data: Record<string, unknown>;
  agentVersion: string;
  correlatedApplyId: string;
  baseUrl: string;
}): Promise<number> {
  const { siteId, machineId, eventType, data, agentVersion, correlatedApplyId, baseUrl } = params;

  const resendClient = getResend();
  if (!resendClient) {
    console.warn('[agent/alert] Resend not configured — critical display alert dropped');
    return 0;
  }

  const [recipients, tz] = await Promise.all([
    getSiteAlertRecipients(siteId, 'displayAlerts'),
    getMachineTimezone(siteId, machineId),
  ]);
  if (recipients.length === 0) return 0;

  // Build a synthetic single-alert payload that buildDisplayDigestEmail
  // expects — mirrors the queue-write shape from the digest path so the
  // template can't tell the two routes apart.
  const alert: PendingDisplayAlert = {
    docId: `inline-${Date.now()}`,
    siteId,
    machineId,
    eventType,
    data,
    agentVersion,
    correlatedApplyId,
    timestamp: new Date(),
  };

  let emailsSent = 0;
  for (const recipient of recipients) {
    try {
      // Honor per-user mute on the same machine. mutedMachines is the
      // operator's escape hatch for noisy installations; critical-path
      // bypass shouldn't override that intent.
      if (recipient.mutedMachines.includes(machineId)) continue;

      const unsubscribeUrl = recipient.userId !== 'fallback'
        ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
        : undefined;

      const html = buildDisplayDigestEmail(siteId, [alert], unsubscribeUrl, tz);
      const subject = `[owlette] critical display alert on ${machineId}`;

      const result = await resendClient.emails.send({
        from: FROM_EMAIL,
        to: [recipient.email],
        ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
        subject,
        html,
      });
      if (result.error) {
        console.error(`[agent/alert] Resend error for ${recipient.email}:`, result.error);
      } else {
        emailsSent++;
      }
    } catch (e) {
      console.error(`[agent/alert] Failed to send critical display email to ${recipient.email}:`, e);
    }
  }
  console.log(
    `[agent/alert] Critical display email sent: ${eventType} on ${machineId} → ${emailsSent}/${recipients.length} recipients`,
  );
  return emailsSent;
}
