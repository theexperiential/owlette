import * as Sentry from "@sentry/nextjs";

/**
 * Fail loudly when a production server boots without the distributed rate
 * limiter.
 *
 * Deliberately does NOT throw. Missing Upstash credentials degrade rate
 * limiting to a per-process in-memory fallback rather than removing it, so
 * hard-failing here would turn a partial weakening into a full outage — the
 * wrong trade for a credential rotation that went sideways at 3am. Instead we
 * make it impossible to miss: an unmissable stderr banner plus a Sentry event
 * that pages the same way any other production error does.
 */
async function checkRateLimitBackend() {
  // Build-time module evaluation has no runtime env; skip it.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production") return;
  // E2E runs against the emulator with rate limiting intentionally relaxed.
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
 * Warn when a production server boots without Turnstile configured.
 *
 * Unlike the rate limiter, the request path here already fails CLOSED when
 * `TURNSTILE_SECRET` is absent in production (see lib/turnstile.server.ts) —
 * register and password-reset would start returning 403. This check exists so
 * the cause is obvious in the logs instead of being diagnosed from user
 * reports of a broken signup form.
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
