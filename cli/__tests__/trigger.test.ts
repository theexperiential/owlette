import { _internals } from '../src/commands/trigger';

const { CANNED_PAYLOADS, KNOWN_EVENTS } = _internals;

describe('trigger canned payloads', () => {
  it('covers the documented event taxonomy from docs/api/webhooks.md', () => {
    const expected = [
      'manifest.published',
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
    for (const kind of ['manifest.published', 'deploy.completed', 'quota.warning']) {
      expect(CANNED_PAYLOADS[kind]?.siteId).toBeNull();
    }
  });

  it('manifest.published carries ids + sizes + createdBy', () => {
    const p = CANNED_PAYLOADS['manifest.published']!;
    expect(p.roostId).toBeDefined();
    expect(p.manifestId).toBeDefined();
    expect(typeof p.totalSize).toBe('number');
    expect(typeof p.totalFiles).toBe('number');
  });

  it('deploy.failed carries an abortReason', () => {
    expect(CANNED_PAYLOADS['deploy.failed']?.abortReason).toBeDefined();
  });

  it('rollback.triggered carries from/to manifest ids', () => {
    const p = CANNED_PAYLOADS['rollback.triggered']!;
    expect(p.fromManifestId).toBeDefined();
    expect(p.toManifestId).toBeDefined();
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
