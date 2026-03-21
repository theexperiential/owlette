/**
 * Cortex autonomous escalation system.
 *
 * When autonomous Cortex cannot resolve an issue, it escalates to site admins
 * via email with details of what was investigated and attempted.
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */

import { getSiteAdminEmails } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';

/**
 * Send an escalation email to site admins when autonomous Cortex cannot resolve an issue.
 */
export async function escalate(
  siteId: string,
  eventId: string,
  machineName: string,
  processName: string,
  cortexResponse: string
): Promise<boolean> {
  const recipients = await getSiteAdminEmails(siteId, true);
  if (recipients.length === 0) {
    console.warn(`[cortex/escalation] No admin emails found for site ${siteId}`);
    return false;
  }

  const resend = getResend();
  if (!resend) {
    console.warn('[cortex/escalation] Resend not configured — escalation email not sent');
    return false;
  }

  const subject = `[${ENV_LABEL}] Cortex Escalation: ${processName} on ${machineName}`;
  const html = buildEscalationEmail(machineName, processName, cortexResponse, eventId);

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipients,
    subject,
    html,
  });

  if (result.error) {
    console.error('[cortex/escalation] Resend error:', result.error);
    return false;
  }

  console.log(`[cortex/escalation] Escalation sent for ${processName} on ${machineName} (${eventId})`);
  return true;
}

function buildEscalationEmail(
  machineName: string,
  processName: string,
  cortexResponse: string,
  eventId: string
): string {
  const timestamp = new Date().toLocaleString();

  // Truncate Cortex response for email (keep it readable)
  const truncatedResponse = cortexResponse.length > 2000
    ? cortexResponse.slice(0, 2000) + '\n\n... (truncated)'
    : cortexResponse;

  // Escape HTML in the response
  const escapedResponse = truncatedResponse
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return `
    <h2 style="color:#d32f2f;">Cortex Escalation: ${processName}</h2>
    <p>Owlette Cortex investigated an issue autonomously but was unable to resolve it. Human attention is needed.</p>

    <table style="border-collapse:collapse;width:100%;max-width:500px;">
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Machine</td><td style="padding:6px;">${machineName}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Process</td><td style="padding:6px;">${processName}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Event ID</td><td style="padding:6px;">${eventId}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Time</td><td style="padding:6px;">${timestamp}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;background:#f5f5f5;">Environment</td><td style="padding:6px;">${ENV_LABEL}</td></tr>
    </table>

    <h3 style="margin-top:20px;">Cortex Investigation Report</h3>
    <div style="background:#f9f9f9;border:1px solid #ddd;padding:12px;border-radius:4px;font-family:monospace;font-size:13px;line-height:1.5;">
      ${escapedResponse}
    </div>

    <p style="margin-top:16px;">Review the autonomous conversation in the Cortex dashboard for full details.</p>
    <hr>
    <p style="color:#666;font-size:12px;">This is an automated escalation from Owlette Cortex.</p>
  `;
}
