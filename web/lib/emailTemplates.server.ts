/**
 * Shared branded email layout and helpers.
 *
 * All Owlette emails should use wrapEmailLayout() to produce a consistent
 * dark-themed, branded experience matching the web dashboard.
 *
 * IMPORTANT: Server-side only — never import in client components.
 */

import { ENV_LABEL, isProduction } from '@/lib/resendClient.server';

/* ------------------------------------------------------------------ */
/*  Color palette (OKLCH dashboard values → email-safe hex)            */
/* ------------------------------------------------------------------ */

export const EMAIL_COLORS = {
  bodyBg: '#141726',
  cardBg: '#1e2235',
  altRow: '#262b40',
  border: '#343a56',
  muted: '#9ba2b8',
  text: '#f5f6fa',
  cyan: '#00bcd4',
  amber: '#d4a017',
  red: '#e53935',
  blue: '#42a5f5',
} as const;

/* ------------------------------------------------------------------ */
/*  Severity + metric maps (moved from alerts/trigger/route.ts)        */
/* ------------------------------------------------------------------ */

export const SEVERITY_COLORS: Record<string, string> = {
  info: EMAIL_COLORS.blue,
  warning: EMAIL_COLORS.amber,
  critical: EMAIL_COLORS.red,
};

export const METRIC_LABELS: Record<string, string> = {
  cpu_percent: 'CPU Usage (%)',
  memory_percent: 'Memory Usage (%)',
  disk_percent: 'Disk Usage (%)',
  gpu_percent: 'GPU Usage (%)',
  cpu_temp: 'CPU Temperature (\u00B0C)',
  gpu_temp: 'GPU Temperature (\u00B0C)',
  network_latency: 'Network Latency (ms)',
  network_packet_loss: 'Packet Loss (%)',
};

/* ------------------------------------------------------------------ */
/*  Data table helper                                                  */
/* ------------------------------------------------------------------ */

interface DataRow {
  label: string;
  value: string;
  /** Optional color override for the value cell (e.g. severity color). */
  highlight?: string;
}

/**
 * Build a styled two-column key-value table for email content.
 */
export function emailDataTable(rows: DataRow[]): string {
  const trs = rows
    .map(
      (r) => `
      <tr>
        <td style="padding:10px 14px;font-weight:600;color:${EMAIL_COLORS.muted};background:${EMAIL_COLORS.altRow};border-bottom:1px solid ${EMAIL_COLORS.border};white-space:nowrap;font-size:13px;">${r.label}</td>
        <td style="padding:10px 14px;color:${r.highlight || EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;${r.highlight ? 'font-weight:700;' : ''}">${r.value}</td>
      </tr>`
    )
    .join('');

  return `
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      ${trs}
    </table>`;
}

/* ------------------------------------------------------------------ */
/*  Layout wrapper                                                     */
/* ------------------------------------------------------------------ */

interface EmailLayoutOptions {
  /** Show the environment badge in the header (default: true). */
  showEnvBadge?: boolean;
  /** If provided, adds an unsubscribe link in the footer. */
  unsubscribeUrl?: string;
  /** Hidden preheader text shown in inbox preview. */
  preheader?: string;
}

/**
 * Wrap email body content in the branded Owlette layout.
 *
 * Structure: dark outer bg → 600px card → header (logo + brand) → content → footer.
 * All CSS is inline for maximum email client compatibility.
 */
export function wrapEmailLayout(content: string, options: EmailLayoutOptions = {}): string {
  const { showEnvBadge = true, unsubscribeUrl, preheader } = options;

  const logoUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'}/email-logo.png`;

  const envBadge = showEnvBadge
    ? `<span style="display:inline-block;background:${isProduction ? EMAIL_COLORS.cyan : EMAIL_COLORS.amber};color:${EMAIL_COLORS.bodyBg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;margin-left:10px;vertical-align:middle;letter-spacing:0.5px;">${ENV_LABEL}</span>`
    : '';

  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>`
    : '';

  const unsubscribeHtml = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:${EMAIL_COLORS.muted};text-decoration:underline;font-size:12px;">unsubscribe from alerts</a><span style="color:${EMAIL_COLORS.border};margin:0 8px;">|</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>owlette</title>
</head>
<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  ${preheaderHtml}
  <table width="100%" bgcolor="${EMAIL_COLORS.bodyBg}" cellpadding="0" cellspacing="0" role="presentation" style="background-color:${EMAIL_COLORS.bodyBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Card -->
        <table width="600" style="max-width:600px;background-color:${EMAIL_COLORS.cardBg};border-radius:8px;border:1px solid ${EMAIL_COLORS.border};" cellpadding="0" cellspacing="0" role="presentation">

          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 20px;text-align:center;border-bottom:1px solid ${EMAIL_COLORS.border};">
              <a href="https://owlette.app" style="text-decoration:none;">
                <img src="${logoUrl}" width="48" height="48" alt="owlette" style="display:block;margin:0 auto 12px;border-radius:50%;">
              </a>
              <a href="https://owlette.app" style="color:${EMAIL_COLORS.cyan};font-size:20px;font-weight:700;text-transform:lowercase;letter-spacing:0.5px;text-decoration:none;">owlette</a>
              ${envBadge}
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:28px 32px;color:${EMAIL_COLORS.text};font-size:14px;line-height:1.7;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid ${EMAIL_COLORS.border};text-align:center;">
              <p style="color:${EMAIL_COLORS.muted};font-size:12px;margin:0 0 10px;font-style:italic;">owlette — attention is all you need</p>
              <p style="margin:0 0 10px;">
                <a href="https://owlette.app" style="color:${EMAIL_COLORS.cyan};text-decoration:none;font-size:12px;font-weight:600;">owlette.app</a>
                <span style="color:${EMAIL_COLORS.border};margin:0 6px;">·</span>
                <a href="https://tec.design" style="color:${EMAIL_COLORS.muted};text-decoration:none;font-size:12px;">tec.design</a>
              </p>
              <p style="color:${EMAIL_COLORS.border};font-size:11px;margin:0;">
                ${unsubscribeHtml}this is an automated message from owlette
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Timestamp helper                                                   */
/* ------------------------------------------------------------------ */

/** Format a date for email display in a locale-independent way. */
export function emailTimestamp(date: Date = new Date()): string {
  return date.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}
