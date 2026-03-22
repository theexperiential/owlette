import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { ApiAuthError, requireAdmin } from '@/lib/apiAuth.server';

// Lazy initialization
let resend: Resend | null = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Environment detection
const isProduction = process.env.NODE_ENV === 'production' &&
                     !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    // Check if Resend is configured
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { error: 'RESEND_API_KEY not configured' },
        { status: 500 }
      );
    }

    if (!ADMIN_EMAIL) {
      return NextResponse.json(
        { error: `ADMIN_EMAIL not configured for ${isProduction ? 'production' : 'development'}` },
        { status: 500 }
      );
    }

    const resendClient = getResend();
    if (!resendClient) {
      return NextResponse.json(
        { error: 'Resend client not available' },
        { status: 500 }
      );
    }

    // Parse optional to/cc overrides from request body
    let bodyTo: string | string[] | undefined;
    let bodyCc: string[] | undefined;
    try {
      const body = await request.json();
      if (body.to) bodyTo = Array.isArray(body.to) ? body.to : [body.to];
      if (body.cc) bodyCc = Array.isArray(body.cc) ? body.cc : [body.cc];
    } catch {
      // No body or invalid JSON — use defaults
    }

    const toAddresses = bodyTo || [ADMIN_EMAIL];
    const envLabel = isProduction ? 'PRODUCTION' : 'DEVELOPMENT';
    const timestamp = new Date().toLocaleString();

    // Send test email
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: toAddresses,
      ...(bodyCc && bodyCc.length > 0 ? { cc: bodyCc } : {}),
      subject: `[${envLabel}] Owlette Email Test`,
      html: `
        <h2>Email Test Successful!</h2>
        <p>This is a test email from your Owlette ${envLabel} environment.</p>
        <p><strong>Sent at:</strong> ${timestamp}</p>
        <hr>
        <h3>Configuration:</h3>
        <ul>
          <li><strong>From:</strong> ${FROM_EMAIL}</li>
          <li><strong>To:</strong> ${Array.isArray(toAddresses) ? toAddresses.join(', ') : toAddresses}</li>
          ${bodyCc ? `<li><strong>CC:</strong> ${bodyCc.join(', ')}</li>` : ''}
          <li><strong>Environment:</strong> ${envLabel}</li>
          <li><strong>API Key:</strong> ${process.env.RESEND_API_KEY?.substring(0, 10)}...</li>
        </ul>
        <hr>
        <p style="color: #666; font-size: 12px;">
          This is an automated test email from Owlette.
        </p>
      `,
    });

    if (result.error) {
      return NextResponse.json(
        {
          success: false,
          error: 'Resend API error',
          details: result.error,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Test email sent successfully',
      emailId: result.data?.id,
      from: FROM_EMAIL,
      to: toAddresses,
      ...(bodyCc ? { cc: bodyCc } : {}),
      environment: envLabel,
      timestamp,
    });

  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Error sending test email:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to send test email',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
