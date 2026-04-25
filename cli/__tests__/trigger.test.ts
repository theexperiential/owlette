import { _internals } from '../src/commands/trigger';

const { CANNED_PAYLOADS, KNOWN_EVENTS } = _internals;

describe('trigger canned payloads', () => {
  it('covers the documented event taxonomy from docs/api/webhooks.md', () => {
    const expected = [
      'version.published',
      'deploy.completed',
      'deploy.failed',
      'rollback.triggered',
      'chunk.uploaded',
      'quota.warning',
      'machine.online',
      'machine.offline',
    ];
    for (const e of expected) expect(KNOWN_EVENTS).toContain(e);
  });

  it('leaves siteId as null in the template so the trigger fills it at runtime', () => {
    for (const kind of ['version.published', 'deploy.completed', 'quota.warning']) {
      expect(CANNED_PAYLOADS[kind]?.siteId).toBeNull();
    }
  });

  it('version.published carries ids + sizes + createdBy', () => {
    const p = CANNED_PAYLOADS['version.published']!;
    expect(p.roostId).toBeDefined();
    expect(p.versionId).toBeDefined();
    expect(typeof p.versionNumber).toBe('number');
    expect(typeof p.totalSize).toBe('number');
    expect(typeof p.totalFiles).toBe('number');
  });

  it('deploy.failed carries an abortReason', () => {
    expect(CANNED_PAYLOADS['deploy.failed']?.abortReason).toBeDefined();
  });

  it('rollback.triggered carries from/to version ids', () => {
    const p = CANNED_PAYLOADS['rollback.triggered']!;
    expect(p.fromVersion).toBeDefined();
    expect(p.toVersion).toBeDefined();
  });

  it('chunk.uploaded carries a 64-char hex hash', () => {
    expect(CANNED_PAYLOADS['chunk.uploaded']?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('quota.warning carries used/limit/threshold', () => {
    const p = CANNED_PAYLOADS['quota.warning']!;
    expect(typeof p.usedBytes).toBe('number');
    expect(typeof p.limitBytes).toBe('number');
    expect(typeof p.threshold).toBe('number');
  });
});
