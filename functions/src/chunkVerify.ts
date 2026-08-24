/**
 * Chunk hash verification cloud function (roost wave 2b.2).
 *
 * Defense-in-depth for the CAS invariant: a chunk's filename IS its sha-256. If the bytes
 * hash to anything else the object is corrupt or adversarially planted — delete and alert.
 *
 * HTTPS callable rather than `onObjectFinalized`, because the storage backend is
 * Cloudflare R2, which emits no Firebase storage events. Production wiring is a
 * Cloudflare Worker webhook per successful R2 PUT (preferred), with a scheduled sweep as
 * backstop. Callers authenticate with a firebase-admin service token so the endpoint
 * isn't reachable from the public internet.
 *
 * Pure decision logic (path parsing, verdict, alert payload) lives in lib/chunkVerifyLogic.ts.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { createHash } from 'crypto';
import {
  buildAlert,
  parseChunkPath,
  verdict,
  type Verdict,
} from './lib/chunkVerifyLogic';

/** Minimum surface an R2/S3-compatible client needs; narrow so a mock can be injected. */
export interface ObjectStore {
  /** Stream the object's bytes. Throws if not found. */
  getStream(objectPath: string): Promise<AsyncIterable<Uint8Array>>;
  /** Delete the object. No-ops if already gone (idempotent). */
  delete(objectPath: string): Promise<void>;
}

/** Signal an alert. In prod, wire this to Sentry + a Firestore audit doc. */
type Alerter = (payload: ReturnType<typeof buildAlert>) => Promise<void>;

export interface VerifyResult {
  verdict: Verdict;
  deleted: boolean;
  alerted: boolean;
}

/**
 * Verify-and-maybe-delete with no firebase/network bindings: callers inject the store +
 * alerter. Returns what happened.
 */
export async function verifyAndDelete(
  objectPath: string,
  store: ObjectStore,
  alerter: Alerter,
  now: Date = new Date(),
): Promise<VerifyResult> {
  // fast-path: a malformed path is deleted either way, so don't stream the bytes.
  if (!parseChunkPath(objectPath)) {
    const v: Verdict = { ok: false, reason: 'malformed_path', parsed: null };
    const alert = buildAlert(objectPath, v, now);
    await Promise.allSettled([store.delete(objectPath), alerter(alert)]);
    return { verdict: v, deleted: true, alerted: true };
  }

  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await store.getStream(objectPath);
  } catch (err) {
    // Already deleted (late-fire trigger) — nothing to do; don't alert on absence.
    console.warn(
      `[chunkVerify] cannot read object ${objectPath}: ${(err as Error).message}`,
    );
    return {
      verdict: { ok: false, reason: 'malformed_path', parsed: null },
      deleted: false,
      alerted: false,
    };
  }

  const hash = createHash('sha256');
  for await (const buf of stream) {
    hash.update(buf);
  }
  const computed = hash.digest('hex');

  const v = verdict(objectPath, computed);
  if (v.ok) {
    return { verdict: v, deleted: false, alerted: false };
  }

  const alert = buildAlert(objectPath, v, now);
  await Promise.allSettled([store.delete(objectPath), alerter(alert)]);
  return { verdict: v, deleted: true, alerted: true };
}

/**
 * POST /verifyChunk — body `{ objectPath: string }`.
 *
 * Auth: `Authorization: Bearer <firebase-id-token>` whose UID is in the allowlist env
 * `CHUNK_VERIFY_CALLER_UIDS` (comma-separated). Unrecognised callers get 401, so an
 * accidentally-public endpoint fails closed.
 */
export const verifyChunk = onRequest(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const authOk = await isAuthorizedCaller(req.headers.authorization);
    if (!authOk) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const body = req.body as { objectPath?: unknown } | undefined;
    const objectPath = typeof body?.objectPath === 'string' ? body.objectPath : '';
    if (!objectPath) {
      res.status(400).json({ error: 'objectPath_required' });
      return;
    }

    try {
      const result = await verifyAndDelete(
        objectPath,
        getDefaultStore(),
        alertViaLogAndFirestore,
      );
      res.status(200).json({
        ok: result.verdict.ok,
        deleted: result.deleted,
        alerted: result.alerted,
        reason: result.verdict.ok ? undefined : result.verdict.reason,
      });
    } catch (err) {
      console.error('[chunkVerify] unexpected', err);
      res.status(500).json({ error: 'internal' });
    }
  },
);

/**
 * Lazily resolve the R2 object store — a function, not a module constant, so importing
 * this module in tests doesn't trigger R2 credential validation. Throwing stub until
 * wave 0.5 provisions R2 and wires an S3-compatible client at the R2 endpoint.
 */
function getDefaultStore(): ObjectStore {
  return {
    async getStream(_objectPath: string): Promise<AsyncIterable<Uint8Array>> {
      throw new Error(
        'R2 object store not wired — blocked on wave 0.5 (cloudflare r2 setup)',
      );
    },
    async delete(_objectPath: string): Promise<void> {
      throw new Error(
        'R2 object store not wired — blocked on wave 0.5 (cloudflare r2 setup)',
      );
    },
  };
}

async function alertViaLogAndFirestore(
  payload: ReturnType<typeof buildAlert>,
): Promise<void> {
  console.error(JSON.stringify({ severity: 'ERROR', ...payload }));
  // per-site audit collection, for dashboard surfacing
  try {
    const siteId = payload.siteId ?? '__unknown__';
    await getFirestore()
      .collection('sites')
      .doc(siteId)
      .collection('chunk_verify_alerts')
      .add(payload);
  } catch (err) {
    // A logging-write failure must never break the delete path; stderr is the backup channel.
    console.error(
      `[chunkVerify] failed to persist alert: ${(err as Error).message}`,
    );
  }
}

async function isAuthorizedCaller(
  authorizationHeader: string | undefined,
): Promise<boolean> {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token) return false;
  const allowlist = (process.env.CHUNK_VERIFY_CALLER_UIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    // fail-closed: un-set env var means no caller is allowed.
    return false;
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return allowlist.includes(decoded.uid);
  } catch {
    return false;
  }
}
