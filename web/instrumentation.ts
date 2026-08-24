import * as Sentry from "@sentry/nextjs";

/**
 * Loud warning when production boots without the distributed rate limiter.
 * Deliberately does NOT throw: missing Upstash creds degrade to the in-memory
 * fallback, so hard-failing would turn a partial weakening into an outage.
 */
async function checkRateLimitBackend() {
  // build-time evaluation has no runtime env
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production") return;
  // e2e relaxes rate limiting on purpose
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true") return;
  if (process.env.E2E_DISABLE_RATE_LIMIT === "true") return;

  const { isDistributedRateLimitEnabled } = await import("./lib/rateLimit");
  if (isDistributedRateLimitEnabled()) return;

  const message =
    "[RateLimit] PRODUCTION BOOT WITHOUT DISTRIBUTED RATE LIMITING. " +
    "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are missing, so every " +
    "endpoint has collapsed to the per-process in-memory fallback " +
    "(15 req/min/identifier, per replica). Per-endpoint limits — including the " +
    "signup limiter — are NOT being enforced.";

  console.error("=".repeat(72));
  console.error(message);
  console.error("=".repeat(72));

  Sentry.captureMessage(message, "error");
}

/**
 * Warn when production boots without Turnstile. The request path already fails
 * CLOSED without `TURNSTILE_SECRET` (lib/turnstile.server.ts) — register and
 * password-reset 403 — so this just puts the cause in the logs.
 */
function checkTurnstileConfigured() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true") return;
  if (process.env.TURNSTILE_SECRET) return;

  const message =
    "[Turnstile] PRODUCTION BOOT WITHOUT TURNSTILE_SECRET. " +
    "Registration (/api/users/bootstrap for password signups) and " +
    "/api/auth/forgot-password will reject every request with 403 until this " +
    "is set.";

  console.error("=".repeat(72));
  console.error(message);
  console.error("=".repeat(72));

  Sentry.captureMessage(message, "error");
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    await checkRateLimitBackend();
    checkTurnstileConfigured();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
