import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
    (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.includes("dev") ? "development" : "production"),

  release: `owlette-web@${process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0"}`,

  // Free plan: errors only
  tracesSampleRate: 0,

  // No-op when DSN is not configured
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});
