import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertEmailsWithCc } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS } from '@/lib/emailTemplates.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { checkRateLimit, processAlertRateLimit } from '@/lib/rateLimit';
import { fireWebhooks } from '@/lib/webhookSender.server';

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
  agentVersion: string
): string {
  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">agent alert</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">an error was detected on an owlette agent.</p>
    ${emailDataTable([
      { label: 'machine', value: machineId },
      { label: 'site', value: siteId },
      { label: 'error code', value: errorCode },
      { label: 'message', value: errorMessage },
      { label: 'agent version', value: agentVersion },
      { label: 'time', value: emailTimestamp() },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
  `;
  return wrapEmailLayout(content);
}

function buildProcessAlertEmail(
  machineId: string,
  processName: string,
  errorMessage: string,
  agentVersion: string,
  eventType: string
): string {
  const eventLabel = eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process ${eventLabel}: ${processName}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a monitored process has ${eventLabel} on one of your machines.</p>
    ${emailDataTable([
      { label: 'machine', value: machineId },
      { label: 'process', value: processName },
      { label: 'event', value: eventLabel },
      { label: 'error', value: errorMessage },
      { label: 'agent version', value: agentVersion },
      { label: 'time', value: emailTimestamp() },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
  `;
  return wrapEmailLayout(content, { preheader: `process ${eventLabel}: ${processName} on ${machineId}` });
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
      const { siteId, machineId, errorCode, errorMessage, agentVersion, eventType, processName } = body;

      // Determine event type (default to connection_failure for backward compat)
      const resolvedEventType = eventType || 'connection_failure';
      const isProcessEvent = resolvedEventType === 'process_crash' || resolvedEventType === 'process_start_failed';

      // Validate required fields
      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId' },
          { status: 400 }
        );
      }

      if (!isProcessEvent && !errorCode) {
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

      // Check Resend is configured
      const resendClient = getResend();
      if (!resendClient) {
        console.warn('[agent/alert] RESEND_API_KEY not configured — alert not sent');
        return NextResponse.json({ success: true, emailSent: false, reason: 'Resend not configured' });
      }

      // Get recipient emails based on event type
      const { to: recipients, cc } = await getSiteAlertEmailsWithCc(
        siteId,
        isProcessEvent ? 'processAlerts' : 'healthAlerts'
      );

      if (recipients.length === 0) {
        console.warn(`[agent/alert] No recipients found for site ${siteId}`);
        return NextResponse.json({ success: true, emailSent: false, reason: 'No recipients' });
      }

      // Build email based on event type
      let subject: string;
      let html: string;

      if (isProcessEvent) {
        const eventLabel = resolvedEventType === 'process_start_failed' ? 'failed to start' : 'crashed';
        subject = `[${ENV_LABEL}] Process ${eventLabel}: ${processName} on ${machineId}`;
        html = buildProcessAlertEmail(machineId, processName, errorMessage || '', agentVersion || '', resolvedEventType);
      } else {
        subject = `[${ENV_LABEL}] [ALERT] Owlette agent error on ${machineId}`;
        html = buildAlertEmail(siteId, machineId, errorCode, errorMessage || '', agentVersion || '');
      }

      // Send alert email
      const result = await resendClient.emails.send({
        from: FROM_EMAIL,
        to: recipients,
        ...(cc.length > 0 ? { cc } : {}),
        subject,
        html,
      });

      if (result.error) {
        console.error('[agent/alert] Resend error:', result.error);
        return NextResponse.json({ error: 'Email delivery failed' }, { status: 500 });
      }

      console.log(`[agent/alert] Alert sent for ${machineId} (${siteId}): ${resolvedEventType}${isProcessEvent ? ` - ${processName}` : ''}`);

      // Fire webhooks (non-blocking — don't delay the response)
      const webhookEvent = resolvedEventType === 'process_crash' ? 'process.crashed'
        : resolvedEventType === 'process_start_failed' ? 'process.restarted'
        : 'machine.offline';
      const db = getAdminDb();
      const siteDoc = await db.collection('sites').doc(siteId).get();
      const siteName = siteDoc.data()?.name || siteId;
      fireWebhooks(siteId, siteName, webhookEvent, {
        machine: { id: machineId, name: machineId },
        ...(processName ? { process: { name: processName, error: errorMessage || '' } } : {}),
      }).catch(console.error);

      // Trigger autonomous Cortex investigation (non-blocking, process events only)
      // Skip if local Cortex is running — it handles investigation via IPC events
      if (isProcessEvent) {
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
      }

      return NextResponse.json({ success: true, emailSent: true, recipients: recipients.length });
    } catch (error: unknown) {
      console.error('[agent/alert] Unhandled error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
