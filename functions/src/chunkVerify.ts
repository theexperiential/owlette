/**
 * Chunk hash verification cloud function (roost wave 2b.2).
 *
 * Defense-in-depth for the CAS invariant: the filename of a chunk is
 * its sha-256. If the bytes hash to something else, the object is
 * corrupted or adversarially planted; delete it immediately and alert.
 *
 * **Trigger**: HTTPS callable. The roost plan mandates Cloudflare R2 as
 * the storage backend, which does not emit Firebase `onObjectFinalized`
 * events directly. Two wiring options for production:
 *
 *   1. Cloudflare Worker fires a webhook → POST this endpoint (preferred
 *      — fires on every successful R2 PUT).
 *   2. Scheduled sweep over recently-uploaded chunks (backstop; only
 *      needed if the worker path fails).
 *
 * Callers authenticate with a firebase-admin-generated service token so
 * this endpoint can't be called from the public internet. The function
 * streams the object from R2, computes sha-256, and acts on the verdict.
 *
 * The pure decision logic (path parsing + verdict + alert payload) lives
 * in lib/chunkVerifyLogic.ts.
 */

import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import {
  buildAlert,
  parseChunkPath,
  verdict,
  type Verdict,
} from './lib/chunkVerifyLogic';

/** Minimum surface an R2/S3-compatible client needs. Kept narrow so the
 *  handler can be tested by injecting a mock store in the future. */
export interface ObjectStore {
  /** Stream the object's bytes. Throws if not found. */
  getStream(objectPath: string): Promise<AsyncIterable<Uint8Array>>;
  /** Delete the object. No-ops if already gone (idempotent). */
  delete(objectPath: string): Promise<void>;
}

/** Signal an alert. In prod, wire this to Sentry + a Firestore audit doc. */
type Alerter = (payload: ReturnType<typeof buildAlert>) => Promise<void>;

/* --------------------------------------------------------------------- */
/*  Pure orchestrator (testable)                                         */
/* --------------------------------------------------------------------- */

export interface VerifyResult {
  verdict: Verdict;
  deleted: boolean;
  alerted: boolean;
}

/**
 * Orchestrate the verify-and-maybe-delete flow without any
 * firebase-specific or network-specific bindings. Callers inject the
 * store + alerter; returns what happened.
 */
export async function verifyAndDelete(
  objectPath: string,
  store: ObjectStore,
  alerter: Alerter,
  now: Date = new Date(),
): Promise<VerifyResult> {
  // fast-path: if the path is malformed, no need to stream the bytes —
  // we're deleting either way.
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
    // object might already have been deleted (late-fire trigger). treat
    // as "nothing to do" — don't alert on absence.
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

/* --------------------------------------------------------------------- */
/*  HTTPS entrypoint                                                     */
/* --------------------------------------------------------------------- */

/**
 * POST /verifyChunk
 *
 * Body: `{ objectPath: string }`
 *
 * Authentication: caller must present a firebase ID token via
 * `Authorization: Bearer <id-token>` whose UID is listed in the
 * service-account allowlist (env `CHUNK_VERIFY_CALLER_UIDS`, comma-
 * separated). First call with an unrecognised caller returns 401 so
 * accidentally-public endpoints fail closed.
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

/* --------------------------------------------------------------------- */
/*  Production wiring (R2 client injected at deploy-time)                */
/* --------------------------------------------------------------------- */

/**
 * Lazily resolve the R2 object store. Kept as a function (not a module
 * constant) so tests that import this module don't hit R2 credential
 * validation on load.
 *
 * Production deployment will wire this to an R2 S3-compatible client
 * (e.g. `@aws-sdk/client-s3` pointed at the R2 endpoint). Left as a
 * throwing stub here — wave 0.5 provisions R2 and wires this.
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
  // structured stderr for monitoring/alert rules
  console.error(JSON.stringify({ severity: 'ERROR', ...payload }));
  // append to a per-site audit collection for dashboard surfacing
  try {
    const siteId = payload.siteId ?? '__unknown__';
    await admin
      .firestore()
      .collection('sites')
      .doc(siteId)
      .collection('chunk_verify_alerts')
      .add(payload);
  } catch (err) {
    // logging-write failures must never break the delete path; console
    // + structured severity is the backup channel.
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
    const decoded = await admin.auth().verifyIdToken(token);
    return allowlist.includes(decoded.uid);
  } catch {
    return false;
  }
}
