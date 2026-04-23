/**
 * Append-only audit log sink (roost wave 2b.7).
 *
 * Captured events:
 *   signed_url_issued        — chunks/upload-urls + chunks/download-urls
 *   distribution_started     — manifest finalised, fan-out kicked
 *   manifest_pointer_changed — currentManifestId flipped (fwd + rollback)
 *   api_key_used             — any owk_* authentication
 *   gc_run                   — chunkGcNightly completion
 *
 * The store is **append-only + hash-chained** (see lib/auditLogLogic.ts).
 * Each record embeds hash(prev || record) so a verifier can prove no
 * record was silently modified or deleted.
 *
 * **What this file does NOT enforce**: the append-only property itself
 * lives in firestore.rules. `firestore.rules` is guarded per CLAUDE.md
 * and needs the operator to add (copied into wave 0.6 deploy notes):
 *
 *     match /sites/{siteId}/audit_log/{recordId} {
 *       allow read:   if isAdminOf(siteId);
 *       allow create: if isAdminOf(siteId) || isServiceAccount();
 *       allow update, delete: if false;   // append-only
 *     }
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import {
  AUDIT_RETENTION_DAYS,
  buildAuditRecord,
  canonicaliseEvent,
  GENESIS_HASH,
  verifyChain,
  type AuditEvent,
  type AuditRecord,
} from './lib/auditLogLogic';

/* --------------------------------------------------------------------- */
/*  Dependency interfaces                                                */
/* --------------------------------------------------------------------- */

export interface AuditStore {
  /**
   * Return the latest record's hash for this site, or GENESIS_HASH if
   * the chain is empty. Used as `previousHash` for the next append.
   */
  getLatestHash(siteId: string): Promise<string>;
  /**
   * Append a new record. Implementations SHOULD assert the record's
   * `previousHash` matches the current head inside a transaction so
   * concurrent appends to the same site don't fork the chain.
   */
  append(record: AuditRecord): Promise<void>;
  /**
   * Read the full chain (or a prefix) for verification. Returned in
   * recordedAt-ascending order.
   */
  readChain(siteId: string, limit?: number): Promise<AuditRecord[]>;
}

export interface AuditExporter {
  /**
   * Send a batch of records to the cold-storage sink (BigQuery in prod).
   * Invoked by the daily export scheduled function.
   */
  exportBatch(records: readonly AuditRecord[]): Promise<void>;
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — append                                           */
/* --------------------------------------------------------------------- */

export interface AppendDeps {
  store: AuditStore;
  now?: () => Date;
}

export interface AppendResult {
  ok: true;
  record: AuditRecord;
}
export interface AppendFailure {
  ok: false;
  reason: string;
}

/**
 * Validate the event, read head, build a chain-linked record, append.
 * Returns the persisted record on success (callers log the hash for
 * correlation).
 *
 * Stashes no state — all chain continuation comes from the store.
 */
export async function appendAudit(
  raw: Partial<AuditEvent> | undefined,
  deps: AppendDeps,
): Promise<AppendResult | AppendFailure> {
  const validated = canonicaliseEvent(raw);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const now = deps.now ? deps.now() : new Date();
  const previousHash = await deps.store.getLatestHash(validated.event.siteId);
  const record = buildAuditRecord(
    validated.event,
    previousHash,
    now.getTime(),
  );
  try {
    await deps.store.append(record);
  } catch (err) {
    // If a concurrent writer beat us, the transactional store rejects
    // the append with a distinctive error. Surface a 409 to the caller
    // so it can retry (will pick up the new head on re-read).
    return {
      ok: false,
      reason: `append_failed: ${(err as Error).message}`,
    };
  }
  return { ok: true, record };
}

/* --------------------------------------------------------------------- */
/*  Verification entrypoint                                              */
/* --------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean;
  records: number;
  brokenAt?: number;
  reason?: string;
}

export async function verifySiteChain(
  siteId: string,
  store: AuditStore,
): Promise<VerifyResult> {
  const chain = await store.readChain(siteId);
  const result = verifyChain(chain, { assertGenesis: true });
  if (result.ok) return { ok: true, records: chain.length };
  return {
    ok: false,
    records: chain.length,
    brokenAt: result.brokenAt,
    reason: result.reason,
  };
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — export                                           */
/* --------------------------------------------------------------------- */

export interface ExportDeps {
  store: AuditStore;
  exporter: AuditExporter;
  directory: { listSiteIds(): Promise<string[]> };
  batchSize?: number;
}

export async function exportAllSites(
  deps: ExportDeps,
): Promise<{ siteId: string; exported: number }[]> {
  const batchSize = deps.batchSize ?? 500;
  const siteIds = await deps.directory.listSiteIds();
  const out: { siteId: string; exported: number }[] = [];

  for (const siteId of siteIds) {
    try {
      const chain = await deps.store.readChain(siteId);
      // batch-export so we don't hold a single giant payload in memory.
      // chain is ascending; stream as we go.
      let exported = 0;
      for (let i = 0; i < chain.length; i += batchSize) {
        const batch = chain.slice(i, i + batchSize);
        await deps.exporter.exportBatch(batch);
        exported += batch.length;
      }
      out.push({ siteId, exported });
    } catch (err) {
      console.error(
        `[auditLog] export failed for ${siteId}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

/* --------------------------------------------------------------------- */
/*  Scheduled + HTTPS entrypoints                                        */
/* --------------------------------------------------------------------- */

export const recordAuditEvent = onRequest(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const result = await appendAudit(
      (req.body ?? {}) as Partial<AuditEvent>,
      { store: getDefaultStore() },
    );
    if (!result.ok) {
      res.status(result.reason.startsWith('append_failed') ? 409 : 400).json({
        error: result.reason,
      });
      return;
    }
    res.status(201).json({ recordedAt: result.record.recordedAt, hash: result.record.hash });
  },
);

export const verifyAuditChain = onRequest(
  { timeoutSeconds: 30, memory: '512MiB' },
  async (req, res) => {
    const siteId = String(req.query.siteId ?? '');
    if (!siteId) {
      res.status(400).json({ error: 'siteId_required' });
      return;
    }
    const result = await verifySiteChain(siteId, getDefaultStore());
    res.status(result.ok ? 200 : 422).json(result);
  },
);

/** Daily at 05:15 UTC — after 04:30 telemetry, last of the night. */
export const exportAuditDaily = onSchedule(
  { schedule: '15 5 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const results = await exportAllSites({
      store: getDefaultStore(),
      exporter: getDefaultExporter(),
      directory: getDefaultDirectory(),
    });
    const totalExported = results.reduce((n, r) => n + r.exported, 0);
    console.log(
      `[auditLog] daily export complete: sites=${results.length} records=${totalExported} retention_days=${AUDIT_RETENTION_DAYS}`,
    );
  },
);

/* --------------------------------------------------------------------- */
/*  Production wiring                                                    */
/* --------------------------------------------------------------------- */

function getDefaultStore(): AuditStore {
  const db = admin.firestore();
  const col = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('audit_log');
  const headDoc = (siteId: string) =>
    db
      .collection('sites')
      .doc(siteId)
      .collection('audit_log_meta')
      .doc('head');

  return {
    async getLatestHash(siteId: string) {
      const snap = await headDoc(siteId).get();
      const data = snap.exists
        ? (snap.data() as { hash?: string })
        : undefined;
      return data?.hash ?? GENESIS_HASH;
    },
    async append(record: AuditRecord) {
      // transactional compare-and-swap on the head doc to serialise
      // concurrent appends to the same site.
      await db.runTransaction(async (tx) => {
        const headSnap = await tx.get(headDoc(record.event.siteId));
        const currentHead = headSnap.exists
          ? ((headSnap.data() as { hash?: string }).hash ?? GENESIS_HASH)
          : GENESIS_HASH;
        if (record.previousHash !== currentHead) {
          throw new Error('head_changed_during_append');
        }
        tx.set(col(record.event.siteId).doc(record.hash), record);
        tx.set(headDoc(record.event.siteId), {
          hash: record.hash,
          recordedAt: record.recordedAt,
        });
      });
    },
    async readChain(siteId: string, limit?: number) {
      let q = col(siteId).orderBy('recordedAt', 'asc');
      if (typeof limit === 'number') q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => d.data() as AuditRecord);
    },
  };
}

function getDefaultDirectory() {
  const db = admin.firestore();
  return {
    async listSiteIds() {
      const snap = await db.collection('sites').listDocuments();
      return snap.map((d) => d.id);
    },
  };
}

function getDefaultExporter(): AuditExporter {
  // BigQuery wiring is deferred to wave 0.6. In the meantime, the
  // in-firestore chain is the authoritative store and the 7-year
  // retention is enforced by NOT running any delete job (firestore
  // has no auto-TTL for this path).
  return {
    async exportBatch(_records) {
      throw new Error(
        'BigQuery audit sink not wired — deferred to wave 0.6 (gcp deploy)',
      );
    },
  };
}
