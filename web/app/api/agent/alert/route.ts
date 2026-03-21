import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth } from '@/lib/firebase-admin';
import { getSiteAdminEmails, getSiteProcessAlertEmails } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { checkRateLimit, processAlertRateLimit } from '@/lib/rateLimit';

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
  const timestamp = new Date().toLocaleString();
  return `
    <h2 style="color:#d32f2f;">⚠️ Owlette Agent Alert</h2>
    <p>An error was detected on an Owlette agent.</p>
    <table style="border-collapse:collapse;width:100%;max-width:500px;">
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineId}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Site</td><td style="padding:6px;">${siteId}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Error Code</td><td style="padding:6px;">${errorCode}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Message</td><td style="padding:6px;">${errorMessage}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Agent Version</td><td style="padding:6px;">${agentVersion}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
    </table>
    <p style="margin-top:16px;">Please check the machine and service logs for more details.</p>
    <hr>
    <p style="color:#666;font-size:12px;">This is an automated alert from Owlette.</p>
  `;
}

function buildProcessAlertEmail(
  machineId: string,
  processName: string,
  errorMessage: string,
  agentVersion: string,
  eventType: string
): string {
  const timestamp = new Date().toLocaleString();
  const eventLabel = eventType === 'process_start_failed' ? 'Failed to Start' : 'Crashed';
  return `
    <h2 style="color:#d32f2f;">⚠️ Process ${eventLabel}: ${processName}</h2>
    <p>A monitored process has ${eventLabel.toLowerCase()} on one of your machines.</p>
    <table style="border-collapse:collapse;width:100%;max-width:500px;">
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineId}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Process</td><td style="padding:6px;">${processName}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Event</td><td style="padding:6px;">${eventLabel}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Error</td><td style="padding:6px;">${errorMessage}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Agent Version</td><td style="padding:6px;">${agentVersion}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
    </table>
    <p style="margin-top:16px;">Please check the machine and service logs for more details.</p>
    <hr>
    <p style="color:#666;font-size:12px;">This is an automated alert from Owlette.</p>
  `;
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
      let recipients: string[];
      if (isProcessEvent) {
        recipients = await getSiteProcessAlertEmails(siteId);
      } else {
        recipients = await getSiteAdminEmails(siteId, true);
      }

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
        subject,
        html,
      });

      if (result.error) {
        console.error('[agent/alert] Resend error:', result.error);
        return NextResponse.json({ error: 'Email delivery failed' }, { status: 500 });
      }

      console.log(`[agent/alert] Alert sent for ${machineId} (${siteId}): ${resolvedEventType}${isProcessEvent ? ` - ${processName}` : ''}`);
      return NextResponse.json({ success: true, emailSent: true, recipients: recipients.length });
    } catch (error: unknown) {
      console.error('[agent/alert] Unhandled error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'agentAlert', identifier: 'ip' }
);
