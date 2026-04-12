import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError, requireAdmin } from '@/lib/apiAuth.server';
import { FROM_EMAIL, ENV_LABEL, isProduction } from '@/lib/resendClient.server';
import { apiError } from '@/lib/apiErrorResponse';

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    return NextResponse.json({
      provider: 'Resend',
      fromEmail: FROM_EMAIL,
      adminEmail: ADMIN_EMAIL || null,
      environment: ENV_LABEL,
      apiKeyConfigured: !!process.env.RESEND_API_KEY,
      adminEmailConfigured: !!ADMIN_EMAIL,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'admin/email/config');
  }
}
