/**
 * superadmin api for flipping kill switches (security-boundary-migration wave 2.1).
 *
 * `POST /api/admin/security/kill-switch`
 *
 * body: `{ flag: 'capability_enforcement' | 'rate_limit_enforcement', enabled: boolean, reason: string, expiresInMinutes?: number }`
 *
 * Writes / updates the document at `global/security_config` with the new
 * flag value plus audit metadata (`flippedBy`, `reason`, `expiresAt`).
 * `expiresAt` defaults to `now + 4h` (240 minutes) so an operator can't
 * accidentally leave the fleet unguarded indefinitely — the auto-expiry
 * is enforced by `securityConfig.read()`.
 *
 * Caller MUST be a superadmin. Wrapper-level role gate handles the
 * 403; we don't re-check here. The api-key scope check (`'user' '*'
 * 'admin'` via the wrapper default) ensures only superadmin-grade keys
 * can exercise this endpoint as well.
 */

import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { problemValidation } from '@/lib/apiErrors';
import logger from '@/lib/logger';

const VALID_FLAGS = ['capability_enforcement', 'rate_limit_enforcement'] as const;
type KillSwitchFlag = typeof VALID_FLAGS[number];

const DEFAULT_EXPIRES_MINUTES = 240; // 4h
const MAX_EXPIRES_MINUTES = 60 * 24 * 7; // 1 week — past this, re-flip
const MAX_REASON_LENGTH = 500;

function isFlag(value: unknown): value is KillSwitchFlag {
  return typeof value === 'string' && (VALID_FLAGS as readonly string[]).includes(value);
}

export const POST = authorizedPlatformHandler({
  capability: 'GLOBAL_SETTINGS_WRITE',
})(async (request, ctx) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problemValidation('request body is not valid json');
  }

  if (!body || typeof body !== 'object') {
    return problemValidation('request body must be a json object');
  }
  const b = body as Record<string, unknown>;

  if (!isFlag(b.flag)) {
    return problemValidation(
      `flag must be one of: ${VALID_FLAGS.join(', ')}`,
      { flag: ['invalid value'] },
    );
  }
  const flag = b.flag;

  if (typeof b.enabled !== 'boolean') {
    return problemValidation('enabled must be a boolean', { enabled: ['must be boolean'] });
  }
  const enabled = b.enabled;

  if (typeof b.reason !== 'string' || b.reason.trim().length === 0) {
    return problemValidation('reason is required', { reason: ['must be a non-empty string'] });
  }
  if (b.reason.length > MAX_REASON_LENGTH) {
    return problemValidation(`reason must be <= ${MAX_REASON_LENGTH} chars`, {
      reason: [`max ${MAX_REASON_LENGTH} chars`],
    });
  }
  const reason = b.reason.trim();

  let expiresInMinutes = DEFAULT_EXPIRES_MINUTES;
  if (b.expiresInMinutes !== undefined) {
    if (
      typeof b.expiresInMinutes !== 'number' ||
      !Number.isFinite(b.expiresInMinutes) ||
      b.expiresInMinutes < 1 ||
      b.expiresInMinutes > MAX_EXPIRES_MINUTES
    ) {
      return problemValidation(
        `expiresInMinutes must be a number between 1 and ${MAX_EXPIRES_MINUTES}`,
        { expiresInMinutes: ['out of range'] },
      );
    }
    expiresInMinutes = b.expiresInMinutes;
  }

  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  const db = getAdminDb();
  const docRef = db.collection('global').doc('security_config');

  await docRef.set(
    {
      [flag]: enabled,
      [`${flag}_flippedBy`]: ctx.actor.userId,
      [`${flag}_reason`]: reason,
      [`${flag}_expiresAt`]: expiresAt,
      lastUpdated: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logger.warn('[killSwitch] flag flipped', {
    context: 'killSwitch',
    data: {
      correlationId: ctx.correlationId,
      flag,
      enabled,
      flippedBy: ctx.actor.userId,
      expiresAt: expiresAt.toISOString(),
      reason,
    },
  });

  return NextResponse.json({
    success: true,
    flag,
    enabled,
    expiresAt: expiresAt.toISOString(),
    correlationId: ctx.correlationId,
  });
});

