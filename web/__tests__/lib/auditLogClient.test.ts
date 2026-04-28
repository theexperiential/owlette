/** @jest-environment node */

import {
  scopeFingerprint,
  emitApiKeyUsed,
  emitMutation,
  type MutationKind,
} from '@/lib/auditLogClient';

describe('scopeFingerprint', () => {
  it('returns "legacy" for null scopes', () => {
    expect(scopeFingerprint(null)).toBe('legacy');
  });

  it('returns "legacy" for empty scopes', () => {
    expect(scopeFingerprint([])).toBe('legacy');
  });

  it('produces a 12-char hex string for scoped keys', () => {
    const fp = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['write'] },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across scope reordering', () => {
    const a = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['write', 'read'] },
      { resource: 'roost', id: 'r1', permissions: ['deploy'] },
    ]);
    const b = scopeFingerprint([
      { resource: 'roost', id: 'r1', permissions: ['deploy'] },
      { resource: 'site', id: 's1', permissions: ['read', 'write'] },
    ]);
    expect(a).toBe(b);
  });

  it('differs for different scope sets', () => {
    const a = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['read'] },
    ]);
    const b = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['write'] },
    ]);
    expect(a).not.toBe(b);
  });
});

describe('emitApiKeyUsed', () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const envSnapshot = {
    AUDIT_LOG_URL: process.env.AUDIT_LOG_URL,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
    console.warn = jest.fn();
    delete process.env.AUDIT_LOG_URL;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    if (envSnapshot.AUDIT_LOG_URL) process.env.AUDIT_LOG_URL = envSnapshot.AUDIT_LOG_URL;
    if (envSnapshot.FIREBASE_PROJECT_ID) process.env.FIREBASE_PROJECT_ID = envSnapshot.FIREBASE_PROJECT_ID;
    if (envSnapshot.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = envSnapshot.GCLOUD_PROJECT;
    if (envSnapshot.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = envSnapshot.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    }
  });

  it('no-ops when no audit url can be resolved', () => {
    emitApiKeyUsed({
      siteId: 's1',
      keyId: 'k1',
      scopeFingerprint: 'legacy',
      environment: 'live',
      endpoint: '/api/x',
      method: 'POST',
      isLegacy: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts to AUDIT_LOG_URL when configured', (done) => {
    process.env.AUDIT_LOG_URL = 'https://example.com/recordAuditEvent';
    emitApiKeyUsed({
      siteId: 'site-a',
      keyId: 'key-1',
      scopeFingerprint: 'abc123',
      environment: 'live',
      endpoint: '/api/chunks/check',
      method: 'POST',
      isLegacy: false,
    });
    setImmediate(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/recordAuditEvent',
        expect.objectContaining({ method: 'POST' }),
      );
      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.kind).toBe('api_key_used');
      expect(body.siteId).toBe('site-a');
      expect(body.actor).toBe('apiKey:key-1');
      expect(body.attributes.keyId).toBe('key-1');
      expect(body.attributes.scopeFingerprint).toBe('abc123');
      expect(body.attributes.endpoint).toBe('/api/chunks/check');
      expect(body.attributes.method).toBe('POST');
      done();
    });
  });

  it('computes url from FIREBASE_PROJECT_ID when AUDIT_LOG_URL unset', (done) => {
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    emitApiKeyUsed({
      siteId: 's1',
      keyId: 'k1',
      scopeFingerprint: 'x',
      environment: 'test',
      endpoint: '/x',
      method: 'GET',
      isLegacy: false,
    });
    setImmediate(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        'https://us-central1-my-project.cloudfunctions.net/recordAuditEvent',
        expect.any(Object),
      );
      done();
    });
  });

  it('swallows fetch errors without throwing', (done) => {
    process.env.AUDIT_LOG_URL = 'https://example.com/recordAuditEvent';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
    expect(() =>
      emitApiKeyUsed({
        siteId: 's1',
        keyId: 'k1',
        scopeFingerprint: 'x',
        environment: 'live',
        endpoint: '/x',
        method: 'GET',
        isLegacy: false,
      }),
    ).not.toThrow();
    setImmediate(() => {
      expect(console.warn).toHaveBeenCalled();
      done();
    });
  });

  it('handles deeply-nested endpoint paths from api-sprint waves', (done) => {
    process.env.AUDIT_LOG_URL = 'https://example.com/recordAuditEvent';
    emitApiKeyUsed({
      siteId: 'site-a',
      keyId: 'key-1',
      scopeFingerprint: 'abc',
      environment: 'live',
      endpoint: '/api/sites/site-a/machines/mach-1/processes/proc-xyz',
      method: 'PATCH',
      isLegacy: false,
    });
    setImmediate(() => {
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.attributes.endpoint).toBe(
        '/api/sites/site-a/machines/mach-1/processes/proc-xyz',
      );
      done();
    });
  });
});

describe('emitMutation', () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
    console.warn = jest.fn();
    delete process.env.AUDIT_LOG_URL;
    process.env.AUDIT_LOG_URL = 'https://example.com/recordAuditEvent';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    delete process.env.AUDIT_LOG_URL;
  });

  it.each<MutationKind>([
    'api_key_mutated',
    'chunk_mutated',
    'deployment_mutated',
    'distribution_mutated',
    'process_mutated',
    'roost_mutated',
    'machine_command_dispatched',
    'user_mutated',
    'site_mutated',
    'site_member_mutated',
    'installer_mutated',
    'webhook_mutated',
    'chat_mutated',
  ])('posts a %s event with kind, actor, target, and attributes', (kind, done) => {
    emitMutation({
      kind,
      siteId: 'site-a',
      actor: 'apiKey:key-1',
      targetId: 'tgt_abc',
      attributes: {
        endpoint: '/api/test',
        method: 'POST',
        sample: true,
      },
    });
    setImmediate(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.kind).toBe(kind);
      expect(body.siteId).toBe('site-a');
      expect(body.actor).toBe('apiKey:key-1');
      expect(body.target).toBe('tgt_abc');
      expect(body.attributes.endpoint).toBe('/api/test');
      expect(body.attributes.sample).toBe(true);
      expect(typeof body.occurredAt).toBe('number');
      (done as () => void)();
    });
  });

  it('accepts user:<uid> actor for session-mediated mutations', (done) => {
    emitMutation({
      kind: 'site_member_mutated',
      siteId: 'site-a',
      actor: 'user:uid_abc',
      targetId: 'uid_xyz',
      attributes: { verb: 'add', endpoint: '/api/sites/site-a/members', method: 'POST' },
    });
    setImmediate(() => {
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.actor).toBe('user:uid_abc');
      done();
    });
  });

  it('accepts empty siteId for platform-wide mutations (user/installer)', (done) => {
    emitMutation({
      kind: 'installer_mutated',
      siteId: '',
      actor: 'user:uid_super',
      targetId: '2.10.0',
      attributes: { verb: 'set-latest' },
    });
    setImmediate(() => {
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.siteId).toBe('');
      expect(body.kind).toBe('installer_mutated');
      done();
    });
  });

  it('swallows fetch errors without throwing', (done) => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
    expect(() =>
      emitMutation({
        kind: 'deployment_mutated',
        siteId: 'site-a',
        actor: 'apiKey:key-1',
        targetId: 'dep_abc',
        attributes: {},
      }),
    ).not.toThrow();
    setImmediate(() => {
      expect(console.warn).toHaveBeenCalled();
      done();
    });
  });

  it('no-ops when no audit url can be resolved', () => {
    delete process.env.AUDIT_LOG_URL;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    emitMutation({
      kind: 'process_mutated',
      siteId: 'site-a',
      actor: 'apiKey:k',
      targetId: 'p_1',
      attributes: {},
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
