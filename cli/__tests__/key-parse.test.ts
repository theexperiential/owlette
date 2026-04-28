import { _internals } from '../src/commands/key';

const { parseScopeSpec, summariseScopes, statusOf, PRESETS } = _internals;

describe('parseScopeSpec', () => {
  it('parses a canonical spec with one permission', () => {
    const result = parseScopeSpec('roost=rst_abc:write');
    expect(result).toEqual({ resource: 'roost', id: 'rst_abc', permissions: ['write'] });
  });

  it('parses multiple comma-separated permissions + dedups', () => {
    const result = parseScopeSpec('roost=rst_abc:write,deploy,write');
    expect(result).toEqual({
      resource: 'roost',
      id: 'rst_abc',
      permissions: ['write', 'deploy'],
    });
  });

  it('accepts wildcard id', () => {
    const result = parseScopeSpec('site=*:read');
    expect(result).toEqual({ resource: 'site', id: '*', permissions: ['read'] });
  });

  it('rejects unknown resource', () => {
    expect(parseScopeSpec('widget=x:read')).toMatch(/resource must be one of/);
  });

  it.each(['chat', 'deploy', 'process', 'user', 'installer'] as const)(
    'accepts public-api resource %s',
    (resource) => {
      expect(parseScopeSpec(`${resource}=*:read`)).toEqual({
        resource,
        id: '*',
        permissions: ['read'],
      });
    },
  );

  it('rejects missing : separator', () => {
    expect(parseScopeSpec('roost=rst_abc')).toMatch(/must include.*perm/);
  });

  it('rejects missing = separator', () => {
    expect(parseScopeSpec('roost:rst_abc:write')).toMatch(
      /must be '<resource>=<id>:<perm>/,
    );
  });

  it('rejects empty id (falls through to colon-check when id is empty)', () => {
    // `roost=:write` fails the colon-position test first because `:` is
    // at position 0 of the trailing segment — validator reports the
    // more generic "must include :<perm>" message.
    const result = parseScopeSpec('roost=:write');
    expect(typeof result).toBe('string');
  });

  it('rejects unknown permission', () => {
    expect(parseScopeSpec('roost=rst:teleport')).toMatch(/'teleport' not in/);
  });

  it('rejects empty perm list', () => {
    expect(parseScopeSpec('roost=rst:')).toMatch(/at least one permission/);
  });

  it('trims whitespace', () => {
    expect(parseScopeSpec('  roost = rst_abc : write , deploy ')).toEqual({
      resource: 'roost',
      id: 'rst_abc',
      permissions: ['write', 'deploy'],
    });
  });
});

describe('PRESETS', () => {
  it('covers every resource type with the preset permissions', () => {
    for (const preset of ['readonly', 'publisher', 'operator', 'admin'] as const) {
      const scopes = PRESETS[preset];
      expect(scopes).toHaveLength(4);
      expect(scopes.map((s) => s.resource).sort()).toEqual([
        'chat',
        'machine',
        'roost',
        'site',
      ]);
      for (const s of scopes) expect(s.id).toBe('*');
    }
  });

  it('admin includes every permission', () => {
    const perms = PRESETS.admin[0]!.permissions;
    expect(perms.sort()).toEqual(['admin', 'deploy', 'read', 'rollback', 'write']);
  });

  it('readonly is read-only', () => {
    expect(PRESETS.readonly[0]!.permissions).toEqual(['read']);
  });
});

describe('summariseScopes', () => {
  it('renders each scope as resource=id:perm+perm', () => {
    expect(
      summariseScopes([
        { resource: 'roost', id: 'rst_abc', permissions: ['write', 'deploy'] },
        { resource: 'site', id: '*', permissions: ['read'] },
      ]),
    ).toBe('roost=rst_abc:write+deploy site=*:read');
  });

  it('marks empty scopes as legacy', () => {
    expect(summariseScopes([])).toBe('legacy (full access)');
  });
});

describe('statusOf', () => {
  it('prioritizes revoked > expired > retired > rotated > active', () => {
    expect(statusOf({ expired: false, retired: false, rotatedAt: null, revokedAt: 1 })).toBe(
      'revoked',
    );
    expect(statusOf({ expired: true, retired: false, rotatedAt: null, revokedAt: null })).toBe(
      'expired',
    );
    expect(statusOf({ expired: false, retired: true, rotatedAt: null, revokedAt: null })).toBe(
      'retired',
    );
    expect(statusOf({ expired: false, retired: false, rotatedAt: 1, revokedAt: null })).toBe(
      'rotated',
    );
    expect(
      statusOf({ expired: false, retired: false, rotatedAt: null, revokedAt: null }),
    ).toBe('active');
  });
});
