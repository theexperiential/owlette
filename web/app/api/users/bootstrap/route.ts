/**
 * POST /api/users/bootstrap
 *
 * Server-side user-doc creation on first sign-in / sign-up. Replaces the
 * client-side `setDoc(users/{uid}, ...)` calls in
 * `web/contexts/AuthContext.tsx` (line 421 unsubscribe-listener path; line
 * 527 signUp path) so user-doc creation is server-mediated and audit-logged.
 *
 * **Auth model — handler choice rationale.**
 * The default `authorizedPlatformHandler` requires `actor.role === 'superadmin'`
 * which is the wrong shape for bootstrap: at first sign-in the user has
 * no firestore record yet, so a role lookup returns 'member' (the default
 * narrowing) and the handler 403s — making it impossible for any new
 * user to ever bootstrap themselves. The capability concept also doesn't
 * apply: bootstrap operates on the caller's OWN nonexistent record, so
 * neither USER_ROLE_MANAGE nor any other capability fits. Instead this
 * route uses `requireSessionOrIdToken` directly + a self-target check
 * (the bearer's uid MUST match the bootstrap target, which itself comes
 * from the verified auth context — there's no body-supplied uid). This
 * matches the existing pattern in `/api/webhooks/user-created`.
 *
 * Idempotent — calling twice for the same uid is a no-op (returns
 * `alreadyExists: true`).
 *
 * Body: `{ email, displayName?, timezone? }`. The `uid` is taken from the
 * verified token, not from the body, so a caller cannot bootstrap a doc
 * for someone else.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  ApiAuthError,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import {
  problemFromError,
  problemUnauthorized,
  problemValidation,
} from '@/lib/apiErrors';
import { withIdempotency } from '@/lib/idempotency';
import { withRateLimit } from '@/lib/withRateLimit';
import { bootstrapUser } from '@/lib/actions/bootstrapUser.server';
import { isDisposableEmailDomain } from '@/lib/disposableEmailDomains';
import { readAndParseJsonBody } from '../../_shared';

interface BootstrapBody {
  email?: unknown;
  displayName?: unknown;
  timezone?: unknown;
}

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_DISPLAY_NAME = 200;

async function handleBootstrap(request: NextRequest): Promise<NextResponse> {
  try {
    let userId: string;
    try {
      userId = await requireSessionOrIdToken(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return problemUnauthorized(err.message);
      throw err;
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      { userId, environment: 'unknown' },
      parsed.raw,
      async () => {
        const body = parsed.body as BootstrapBody;

        if (typeof body.email !== 'string' || !EMAIL_REGEX.test(body.email)) {
          return problemValidation(
            'email is required and must be a valid email address',
            { 'body.email': ['must be a valid email address'] },
          );
        }
        if (isDisposableEmailDomain(body.email)) {
          return problemValidation(
            'email address uses a disallowed disposable domain',
            { 'body.email': ['disposable email domains are not permitted'] },
          );
        }
        if (
          body.displayName !== undefined &&
          (typeof body.displayName !== 'string' ||
            body.displayName.length > MAX_DISPLAY_NAME)
        ) {
          return problemValidation('displayName must be a string ≤200 chars', {
            'body.displayName': [`must be a string of ≤${MAX_DISPLAY_NAME} chars`],
          });
        }
        if (
          body.timezone !== undefined &&
          (typeof body.timezone !== 'string' || body.timezone.length > 100)
        ) {
          return problemValidation(
            'timezone must be a string IANA zone id',
            { 'body.timezone': ['must be a string IANA tz id'] },
          );
        }

        const result = await bootstrapUser(
          {
            auditActor: `user:${userId}`,
            endpoint: '/api/users/bootstrap',
            method: 'POST',
          },
          {
            uid: userId,
            email: body.email,
            displayName:
              typeof body.displayName === 'string' ? body.displayName : '',
            timezone:
              typeof body.timezone === 'string' ? body.timezone : undefined,
          },
        );

        if (result.kind === 'already_exists') {
          return NextResponse.json({
            uid: userId,
            alreadyExists: true,
            createdAt: result.createdAt,
          });
        }

        return NextResponse.json({
          uid: result.uid,
          alreadyExists: false,
          email: result.email,
          displayName: result.displayName,
          timezone: result.timezone,
          createdAt: result.createdAt,
        });
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/bootstrap:POST');
  }
}

/**
 * Per-IP signup rate limit (10/hr prod, 100/hr dev). This caps creation of
 * the Firestore `users/{uid}` doc — the visible/admin-table surface — not
 * the upstream Firebase Auth account itself (that belongs to App Check /
 * blocking functions). Honors the `E2E_DISABLE_RATE_LIMIT` escape hatch.
 */
export const POST = withRateLimit(handleBootstrap, {
  strategy: 'signup',
  identifier: 'ip',
});
