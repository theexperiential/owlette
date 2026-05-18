import * as crypto from 'crypto';
import type { Response } from 'express';
import type { Request } from 'firebase-functions/v2/https';

/**
 * Authentication helper for internal-only HTTPS Cloud Functions.
 * - Returns false + sends 503 if CORTEX_INTERNAL_SECRET env var is not set
 * - Returns false + sends 401 if `x-internal-secret` header missing or mismatched
 * - Returns true if header matches
 *
 * Uses crypto.timingSafeEqual for constant-time comparison.
 */
export function requireInternalSecret(req: Request, res: Response): boolean {
  const expected = process.env.CORTEX_INTERNAL_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'not_configured' });
    return false;
  }
  const supplied = req.header('x-internal-secret') ?? '';
  if (supplied.length === 0 || supplied.length !== expected.length) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  try {
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (!crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
  } catch {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
