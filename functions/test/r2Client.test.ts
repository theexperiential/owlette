/**
 * Unit tests for the dependency-free R2/S3 client used by chunk GC.
 *
 * The transport is injected, so these run offline. What they protect:
 *   - key layout stays byte-identical to web/lib/r2Client.server.ts
 *   - `hashFromChunkKey` never turns an unexpected object into a deletion candidate
 *   - a truncated listing can never be mistaken for a complete one
 *   - env resolution refuses to guess which environment's buckets to point at
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketFor,
  canonicalQuery,
  canonicalUri,
  chunkKey,
  chunkPrefix,
  createR2Client,
  deriveSigningKey,
  hashFromChunkKey,
  loadR2Config,
  parseListObjectsV2,
  resolveRoostEnv,
  signRequest,
  versionKey,
  type FetchLike,
  type HttpResponseLike,
  type R2Config,
} from '../src/lib/r2Client';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const CONFIG: R2Config = {
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'shhh',
  env: 'dev',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stubFetch(
  responses: Array<{ status: number; body: string }>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const next = responses[i++];
    if (!next) throw new Error(`unexpected extra request to ${url}`);
    const res: HttpResponseLike = {
      status: next.status,
      async text() {
        return next.body;
      },
    };
    return res;
  };
  return { fetchImpl, calls };
}

function listXml(keys: string[], nextToken?: string): string {
  const contents = keys
    .map((k) => `<Contents><Key>${k}</Key><Size>10</Size></Contents>`)
    .join('');
  const truncated = nextToken
    ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${nextToken}</NextContinuationToken>`
    : '<IsTruncated>false</IsTruncated>';
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}${truncated}</ListBucketResult>`;
}

describe('key layout', () => {
  it('mirrors the web client exactly', () => {
    assert.equal(bucketFor('dev', 'content'), 'owlette-dev-content');
    assert.equal(bucketFor('prod', 'manifests'), 'owlette-prod-manifests');
    assert.equal(chunkPrefix('site-1'), 'project-content/site-1/');
    assert.equal(chunkKey('site-1', HASH_A), `project-content/site-1/aa/${HASH_A}`);
    assert.equal(
      versionKey('site-1', 'roost-1', 'v1'),
      'project-manifests/site-1/roost-1/v1.json',
    );
  });

  it('rejects ids that could escape the tenant prefix', () => {
    assert.throws(() => chunkPrefix('../other'), /invalid siteId/);
    assert.throws(() => chunkKey('site-1', 'NOTAHASH'), /invalid chunk hash/);
    assert.throws(() => versionKey('site-1', 'roost/..', 'v1'), /invalid roostId/);
  });
});

describe('hashFromChunkKey', () => {
  it('round-trips a well-formed key', () => {
    assert.equal(hashFromChunkKey('site-1', chunkKey('site-1', HASH_B)), HASH_B);
  });

  it('returns null for anything that is not this tenant’s chunk key', () => {
    // Every null here is an object GC will leave alone rather than delete.
    assert.equal(hashFromChunkKey('site-1', 'project-content/site-2/aa/' + HASH_A), null);
    assert.equal(hashFromChunkKey('site-1', 'project-manifests/site-1/r/v.json'), null);
    // shard that disagrees with the hash — not a key this codebase ever wrote.
    assert.equal(hashFromChunkKey('site-1', `project-content/site-1/zz/${HASH_A}`), null);
    // extra path depth
    assert.equal(
      hashFromChunkKey('site-1', `project-content/site-1/aa/nested/${HASH_A}`),
      null,
    );
    // not a hash at all
    assert.equal(hashFromChunkKey('site-1', 'project-content/site-1/aa/README'), null);
    // uppercase hex is not what the uploader writes
    assert.equal(
      hashFromChunkKey('site-1', `project-content/site-1/AA/${'A'.repeat(64)}`),
      null,
    );
  });
});

describe('resolveRoostEnv', () => {
  it('honours an explicit ROOST_ENV', () => {
    assert.equal(resolveRoostEnv({ ROOST_ENV: 'prod' }), 'prod');
    assert.equal(resolveRoostEnv({ ROOST_ENV: ' dev ' }), 'dev');
  });

  it('rejects a bogus ROOST_ENV instead of falling back', () => {
    assert.throws(() => resolveRoostEnv({ ROOST_ENV: 'staging' }), /ROOST_ENV/);
  });

  it('derives from an unambiguous firebase project id', () => {
    assert.equal(resolveRoostEnv({ GCLOUD_PROJECT: 'owlette-dev-3838a' }), 'dev');
    assert.equal(resolveRoostEnv({ GCLOUD_PROJECT: 'owlette-prod-90a12' }), 'prod');
  });

  it('throws rather than guessing when the project id is ambiguous', () => {
    assert.throws(() => resolveRoostEnv({}), /set ROOST_ENV/);
    assert.throws(
      () => resolveRoostEnv({ GCLOUD_PROJECT: 'owlette-devprod' }),
      /set ROOST_ENV/,
    );
  });
});

describe('loadR2Config', () => {
  const base = {
    R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_S3_ACCESS_KEY_ID: 'ak',
    R2_S3_SECRET_ACCESS_KEY: 'sk',
    ROOST_ENV: 'dev',
  };

  it('loads a complete env', () => {
    const cfg = loadR2Config({ ...base });
    assert.equal(cfg.endpoint, 'https://acct.r2.cloudflarestorage.com');
    assert.equal(cfg.env, 'dev');
  });

  it('strips a trailing slash from the endpoint', () => {
    const cfg = loadR2Config({ ...base, R2_S3_ENDPOINT: base.R2_S3_ENDPOINT + '/' });
    assert.equal(cfg.endpoint, 'https://acct.r2.cloudflarestorage.com');
  });

  it('throws on each missing var (GC then aborts before touching storage)', () => {
    for (const key of [
      'R2_S3_ENDPOINT',
      'R2_S3_ACCESS_KEY_ID',
      'R2_S3_SECRET_ACCESS_KEY',
    ]) {
      const env = { ...base } as Record<string, string>;
      delete env[key];
      assert.throws(() => loadR2Config(env), new RegExp(key), `expected ${key} to throw`);
    }
  });

  it('rejects an endpoint that is not a bare https origin', () => {
    assert.throws(
      () => loadR2Config({ ...base, R2_S3_ENDPOINT: 'https://acct.r2.dev/bucket' }),
      /R2_S3_ENDPOINT/,
    );
  });
});

describe('sigv4', () => {
  it('matches the AWS published signing-key derivation vector', () => {
    // https://docs.aws.amazon.com/.../sigv4-calculate-signature.html
    const key = deriveSigningKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20150830',
      'us-east-1',
      'iam',
    );
    assert.equal(
      key.toString('hex'),
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  const signed = signRequest({
    method: 'GET',
    host: 'acct123.r2.cloudflarestorage.com',
    path: '/owlette-dev-content/project-content/site-1/aa/' + HASH_A,
    query: { 'list-type': '2' },
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'shhh',
    now: new Date('2026-09-05T02:15:00.000Z'),
  });

  it('emits the expected header set, and never a Host header', () => {
    assert.deepEqual(Object.keys(signed).sort(), [
      'authorization',
      'x-amz-content-sha256',
      'x-amz-date',
    ]);
    // undici rejects a caller-set Host; the transport supplies the value we signed.
    assert.equal('host' in signed, false);
    assert.equal(signed['x-amz-date'], '20260905T021500Z');
    assert.equal(
      signed['x-amz-content-sha256'],
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.match(
      signed.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260905\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('is deterministic and sensitive to every signed input', () => {
    const again = signRequest({
      method: 'GET',
      host: 'acct123.r2.cloudflarestorage.com',
      path: '/owlette-dev-content/project-content/site-1/aa/' + HASH_A,
      query: { 'list-type': '2' },
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'shhh',
      now: new Date('2026-09-05T02:15:00.000Z'),
    });
    assert.equal(again.authorization, signed.authorization);

    const vary = (patch: Record<string, unknown>) =>
      signRequest({
        method: 'GET',
        host: 'acct123.r2.cloudflarestorage.com',
        path: '/owlette-dev-content/project-content/site-1/aa/' + HASH_A,
        query: { 'list-type': '2' },
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'shhh',
        now: new Date('2026-09-05T02:15:00.000Z'),
        ...patch,
      }).authorization;

    assert.notEqual(vary({ method: 'DELETE' }), signed.authorization);
    assert.notEqual(vary({ path: '/other' }), signed.authorization);
    assert.notEqual(vary({ query: { 'list-type': '1' } }), signed.authorization);
    assert.notEqual(vary({ secretAccessKey: 'other' }), signed.authorization);
    assert.notEqual(vary({ host: 'elsewhere.example' }), signed.authorization);
  });

  it('percent-encodes paths and queries the way S3 canonicalisation requires', () => {
    assert.equal(canonicalUri('/bucket/a b/c'), '/bucket/a%20b/c');
    assert.equal(canonicalUri("/bucket/it's(x)"), '/bucket/it%27s%28x%29');
    assert.equal(
      canonicalQuery({ prefix: 'project-content/site-1/', 'list-type': '2' }),
      'list-type=2&prefix=project-content%2Fsite-1%2F',
    );
  });
});

describe('parseListObjectsV2', () => {
  it('extracts keys from a complete page', () => {
    const page = parseListObjectsV2(listXml(['a/b', 'c/d']));
    assert.deepEqual(page.keys, ['a/b', 'c/d']);
    assert.equal(page.nextContinuationToken, null);
  });

  it('returns the continuation token when truncated', () => {
    const page = parseListObjectsV2(listXml(['a'], 'tok-1'));
    assert.equal(page.nextContinuationToken, 'tok-1');
  });

  it('decodes xml entities in keys', () => {
    const page = parseListObjectsV2(listXml(['a&amp;b']));
    assert.deepEqual(page.keys, ['a&b']);
  });

  it('throws when truncated with no token — a short listing must never look complete', () => {
    const xml =
      '<ListBucketResult><Contents><Key>a</Key></Contents><IsTruncated>true</IsTruncated></ListBucketResult>';
    assert.throws(() => parseListObjectsV2(xml), /listing incomplete/);
  });

  it('handles an empty bucket page', () => {
    assert.deepEqual(parseListObjectsV2(listXml([])).keys, []);
  });
});

describe('createR2Client', () => {
  it('follows continuation tokens to the end of the listing', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: listXml(['k1', 'k2'], 'tok') },
      { status: 200, body: listXml(['k3']) },
    ]);
    const client = createR2Client(CONFIG, { fetchImpl });
    const keys = await client.listKeys('owlette-dev-content', 'project-content/s/');
    assert.deepEqual(keys, ['k1', 'k2', 'k3']);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /list-type=2/);
    assert.match(calls[1].url, /continuation-token=tok/);
  });

  it('throws on a listing error rather than reporting an empty bucket', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: '<Error>denied</Error>' }]);
    const client = createR2Client(CONFIG, { fetchImpl });
    await assert.rejects(
      client.listKeys('owlette-dev-content', 'p/'),
      /HTTP 403/,
    );
  });

  it('getText returns null on 404 and the body on 200', async () => {
    const { fetchImpl } = stubFetch([
      { status: 404, body: '<Error>NoSuchKey</Error>' },
      { status: 200, body: '{"schemaVersion":2}' },
    ]);
    const client = createR2Client(CONFIG, { fetchImpl });
    assert.equal(await client.getText('b', 'missing.json'), null);
    assert.equal(await client.getText('b', 'there.json'), '{"schemaVersion":2}');
  });

  it('getText throws on a server error (never mistaken for absent)', async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: 'boom' }]);
    const client = createR2Client(CONFIG, { fetchImpl });
    await assert.rejects(client.getText('b', 'k.json'), /HTTP 500/);
  });

  it('deleteObject is idempotent on 404 and throws on failure', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 204, body: '' },
      { status: 404, body: '' },
      { status: 500, body: 'boom' },
    ]);
    const client = createR2Client(CONFIG, { fetchImpl });
    await client.deleteObject('b', 'k');
    await client.deleteObject('b', 'k');
    await assert.rejects(client.deleteObject('b', 'k'), /HTTP 500/);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['DELETE', 'DELETE', 'DELETE'],
    );
  });

  it('signs every request against the url it actually sends', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: '{}' }]);
    const client = createR2Client(CONFIG, {
      fetchImpl,
      now: () => new Date('2026-09-05T02:15:00.000Z'),
    });
    await client.getText('owlette-dev-manifests', 'project-manifests/s/r/v.json');
    assert.equal(
      calls[0].url,
      'https://acct123.r2.cloudflarestorage.com/owlette-dev-manifests/project-manifests/s/r/v.json',
    );
    assert.match(calls[0].headers.authorization, /Credential=AKIAEXAMPLE\/20260905\/auto\/s3/);
  });
});
