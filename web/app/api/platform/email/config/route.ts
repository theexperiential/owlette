import { NextRequest, NextResponse } from 'next/server';
import { FROM_EMAIL, ENV_LABEL, isProduction } from '@/lib/resendClient.server';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

export const GET = authorizedPlatformHandler({
  capability: 'GLOBAL_SETTINGS_WRITE',
})(async (_request: NextRequest) => {
  try {
    return NextResponse.json({
      provider: 'Resend',
      fromEmail: FROM_EMAIL,
      adminEmail: ADMIN_EMAIL || null,
      environment: ENV_LABEL,
      apiKeyConfigured: !!process.env.RESEND_API_KEY,
      adminEmailConfigured: !!ADMIN_EMAIL,
    });
  } catch (error) {
    return apiError(error, 'platform/email/config');
  }
});
