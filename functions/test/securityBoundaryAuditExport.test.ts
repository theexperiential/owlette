import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutputUriPrefix,
  formatExportTimestamp,
  resolveExportBucket,
  startSecurityBoundaryAuditExport,
} from '../src/securityBoundaryAuditExport';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

describe('security boundary audit export wrapper', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('formats Firestore export timestamps for stable GCS prefixes', () => {
    const timestamp = formatExportTimestamp(new Date('2026-04-29T01:23:58.535Z'));
    assert.equal(timestamp, '20260429T012358Z');
  });

  it('builds the dev scheduled output prefix by default', () => {
    restoreEnv();
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCP_PROJECT;
    delete process.env.FIREBASE_CONFIG;
    delete process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET;
    delete process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_ENV;

    const prefix = buildOutputUriPrefix(new Date('2026-04-29T01:23:58.535Z'));

    assert.equal(
      prefix,
      'gs://owlette-dev-security-boundary-audit-exports/firestore/security-boundary-audit/dev/scheduled/20260429T012358Z',
    );
  });

  it('requires an explicit bucket outside the dev project', () => {
    restoreEnv();
    process.env.GCLOUD_PROJECT = 'owlette-prod-123';
    delete process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET;

    assert.throws(
      () => resolveExportBucket(),
      /SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET is required outside owlette dev/,
    );
  });

  it('starts exportDocuments with audit collection ids', async () => {
    restoreEnv();
    process.env.GCLOUD_PROJECT = 'owlette-dev-3838a';

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('metadata.google.internal')) {
        return new Response(JSON.stringify({ access_token: 'test-token' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ name: 'operations/export-1' }), {
        status: 200,
      });
    }) as typeof fetch;

    const operation = await startSecurityBoundaryAuditExport(
      'gs://bucket/firestore/security-boundary-audit/dev/scheduled/20260429T012358Z',
      fetchImpl,
    );

    assert.equal(operation.name, 'operations/export-1');
    assert.equal(calls.length, 2);
    assert.equal(
      calls[1].url,
      'https://firestore.googleapis.com/v1/projects/owlette-dev-3838a/databases/%28default%29:exportDocuments',
    );
    assert.equal(calls[1].init?.method, 'POST');
    assert.equal(
      (calls[1].init?.headers as Record<string, string>).Authorization,
      'Bearer test-token',
    );
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      outputUriPrefix:
        'gs://bucket/firestore/security-boundary-audit/dev/scheduled/20260429T012358Z',
      collectionIds: ['audit_log', 'entries'],
    });
  });
});
