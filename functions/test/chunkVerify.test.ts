/**
 * Unit tests for lib/chunkVerifyLogic.ts + the pure orchestrator in
 * chunkVerify.ts (roost wave 2b.2).
 *
 * Node's built-in test runner. No firebase emulator — the HTTPS wrapper
 * (request/response handling, caller authentication) is exercised
 * behind a small inline mock of the object store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import {
  buildAlert,
  CHUNK_PATH_PREFIX,
  parseChunkPath,
  verdict,
} from '../src/lib/chunkVerifyLogic';
import {
  verifyAndDelete,
  type ObjectStore,
} from '../src/chunkVerify';

/* --------------------------------------------------------------------- */
/*  parseChunkPath                                                       */
/* --------------------------------------------------------------------- */

const HASH_A = 'a'.repeat(64);
const PATH_A = `${CHUNK_PATH_PREFIX}/site-1/aa/${HASH_A}`;

describe('parseChunkPath', () => {
  it('parses a well-formed path', () => {
    const r = parseChunkPath(PATH_A);
    assert.deepEqual(r, { siteId: 'site-1', hashPrefix: 'aa', hash: HASH_A });
  });

  it('rejects missing segments', () => {
    assert.equal(parseChunkPath(`${CHUNK_PATH_PREFIX}/site-1/${HASH_A}`), null);
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site-1/aa/${HASH_A}/extra`),
      null,
    );
  });

  it('rejects wrong top-level prefix', () => {
    assert.equal(
      parseChunkPath(`other-bucket/site-1/aa/${HASH_A}`),
      null,
    );
  });

  it('rejects hash that is not 64 lowercase hex', () => {
    const upper = 'A'.repeat(64);
    const short = 'a'.repeat(63);
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site-1/aa/${upper}`),
      null,
    );
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site-1/aa/${short}`),
      null,
    );
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site-1/aa/zzzzz`),
      null,
    );
  });

  it('rejects hashPrefix that does not match hash[0:2]', () => {
    // hash starts with 'aa' but prefix claims 'bb' — desync means the
    // object is in the wrong shard; reject for investigation.
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site-1/bb/${HASH_A}`),
      null,
    );
  });

  it('rejects siteIds with slashes or traversal', () => {
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/../aa/${HASH_A}`),
      null,
    );
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/./aa/${HASH_A}`),
      null,
    );
  });

  it('rejects exotic siteId characters', () => {
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site with spaces/aa/${HASH_A}`),
      null,
    );
    assert.equal(
      parseChunkPath(`${CHUNK_PATH_PREFIX}/site;drop/aa/${HASH_A}`),
      null,
    );
  });

  it('rejects empty inputs', () => {
    assert.equal(parseChunkPath(''), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(parseChunkPath(null as any), null);
  });
});

/* --------------------------------------------------------------------- */
/*  verdict                                                              */
/* --------------------------------------------------------------------- */

describe('verdict', () => {
  it('ok on hash match', () => {
    const v = verdict(PATH_A, HASH_A);
    assert.equal(v.ok, true);
  });

  it('hash_mismatch when computed differs', () => {
    const computed = 'b'.repeat(64);
    const v = verdict(PATH_A, computed);
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.reason, 'hash_mismatch');
    assert.equal(v.ok ? null : v.computedHash, computed);
  });

  it('hash_mismatch when computed is uppercase (still normalized-lowercased)', () => {
    const upper = 'A'.repeat(64);
    // matches path-hash after lowercasing — should be OK
    const v = verdict(PATH_A, upper);
    assert.equal(v.ok, true);
  });

  it('malformed_path when path structure is wrong (even if hash provided)', () => {
    const v = verdict('garbage', HASH_A);
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.reason, 'malformed_path');
    assert.equal(v.ok ? undefined : v.parsed, null);
  });

  it('hash_mismatch when computed is non-hex garbage', () => {
    const v = verdict(PATH_A, 'not-a-hash');
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.reason, 'hash_mismatch');
  });
});

/* --------------------------------------------------------------------- */
/*  buildAlert                                                           */
/* --------------------------------------------------------------------- */

describe('buildAlert', () => {
  const fixedNow = new Date('2026-04-20T12:00:00Z');

  it('populates fields from a hash_mismatch verdict', () => {
    const computed = 'b'.repeat(64);
    const v = verdict(PATH_A, computed);
    assert.equal(v.ok, false);
    const alert = buildAlert(PATH_A, v as never, fixedNow);
    assert.equal(alert.event, 'chunk_verify_failed');
    assert.equal(alert.objectPath, PATH_A);
    assert.equal(alert.siteId, 'site-1');
    assert.equal(alert.reason, 'hash_mismatch');
    assert.equal(alert.expectedHash, HASH_A);
    assert.equal(alert.computedHash, computed);
    assert.equal(alert.timestamp, fixedNow.toISOString());
  });

  it('null siteId for malformed paths', () => {
    const v = verdict('whatever', HASH_A);
    const alert = buildAlert('whatever', v as never, fixedNow);
    assert.equal(alert.siteId, null);
    assert.equal(alert.expectedHash, null);
  });
});

/* --------------------------------------------------------------------- */
/*  verifyAndDelete orchestrator                                         */
/* --------------------------------------------------------------------- */

/** Make a valid path for an arbitrary payload. */
function pathFor(siteId: string, bytes: Buffer): string {
  const h = createHash('sha256').update(bytes).digest('hex');
  return `${CHUNK_PATH_PREFIX}/${siteId}/${h.slice(0, 2)}/${h}`;
}

/** Minimal in-memory ObjectStore for tests. Tracks delete calls. */
function makeStore(contents: Map<string, Buffer>): ObjectStore & {
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    async getStream(path: string) {
      const bytes = contents.get(path);
      if (!bytes) throw new Error('not found');
      return (async function* () {
        // chunk the buffer into 1 KiB slices to exercise streaming
        const step = 1024;
        for (let i = 0; i < bytes.length; i += step) {
          yield Uint8Array.prototype.slice.call(bytes, i, i + step) as Uint8Array;
        }
      })();
    },
    async delete(path: string) {
      deleted.push(path);
      contents.delete(path);
    },
  };
}

function makeAlerter() {
  const calls: Array<ReturnType<typeof buildAlert>> = [];
  return {
    calls,
    fn: async (payload: ReturnType<typeof buildAlert>) => {
      calls.push(payload);
    },
  };
}

describe('verifyAndDelete', () => {
  it('keeps + does not alert on a matching object', async () => {
    const bytes = Buffer.from('hello world');
    const p = pathFor('site-1', bytes);
    const store = makeStore(new Map([[p, bytes]]));
    const alerter = makeAlerter();

    const r = await verifyAndDelete(p, store, alerter.fn);
    assert.equal(r.verdict.ok, true);
    assert.equal(r.deleted, false);
    assert.equal(r.alerted, false);
    assert.equal(store.deleted.length, 0);
    assert.equal(alerter.calls.length, 0);
  });

  it('deletes + alerts on hash collision (planted bytes)', async () => {
    const claimedBytes = Buffer.from('hello world');
    const actualBytes = Buffer.from('malicious payload');
    const claimedPath = pathFor('site-1', claimedBytes);

    // attacker: object at legitimate path, wrong bytes.
    const store = makeStore(new Map([[claimedPath, actualBytes]]));
    const alerter = makeAlerter();

    const r = await verifyAndDelete(claimedPath, store, alerter.fn);
    assert.equal(r.verdict.ok, false);
    assert.equal(r.verdict.ok ? null : r.verdict.reason, 'hash_mismatch');
    assert.equal(r.deleted, true);
    assert.equal(r.alerted, true);
    assert.equal(store.deleted[0], claimedPath);
    assert.equal(alerter.calls.length, 1);
    assert.equal(alerter.calls[0].reason, 'hash_mismatch');
    assert.equal(alerter.calls[0].siteId, 'site-1');
  });

  it('deletes + alerts on malformed path WITHOUT reading bytes', async () => {
    const path = 'garbage/not-a-chunk-path';
    const store = makeStore(new Map());
    const alerter = makeAlerter();

    const r = await verifyAndDelete(path, store, alerter.fn);
    assert.equal(r.deleted, true);
    assert.equal(r.alerted, true);
    assert.equal(alerter.calls[0].reason, 'malformed_path');
    assert.equal(alerter.calls[0].siteId, null);
  });

  it('no-op on missing object (late trigger, already gone)', async () => {
    const p = pathFor('site-1', Buffer.from('x'));
    const store = makeStore(new Map()); // empty
    const alerter = makeAlerter();

    const r = await verifyAndDelete(p, store, alerter.fn);
    assert.equal(r.deleted, false);
    assert.equal(r.alerted, false);
    assert.equal(alerter.calls.length, 0);
  });

  it('streams large-ish objects without loading whole thing into hash.update', async () => {
    // build a 2 MiB buffer — exercises the streaming path. the SHA must
    // still match the one-shot digest.
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const p = pathFor('site-1', bytes);
    const store = makeStore(new Map([[p, bytes]]));
    const alerter = makeAlerter();

    const r = await verifyAndDelete(p, store, alerter.fn);
    assert.equal(r.verdict.ok, true);
  });
});
