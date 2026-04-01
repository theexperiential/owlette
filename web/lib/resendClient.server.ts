/**
 * Shared Resend email client and environment constants for server-side use.
 * Import from here instead of re-initializing in each route.
 */

import { Resend } from 'resend';

let resend: Resend | null = null;

export function getResend(): Resend | null {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

export const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

export const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
export const ENV_LABEL = isProduction ? 'PRODUCTION' : 'DEVELOPMENT';
