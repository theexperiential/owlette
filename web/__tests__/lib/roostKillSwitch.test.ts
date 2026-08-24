/**
 * @jest-environment node
 *
 * web/lib/roostKillSwitch.ts. Must agree with `agent/src/roost_kill_switch.py` on fail-open
 * semantics and field name — drift means deploys reach some agents and not others.
 */

import {
  gateOrProceed,
  isEnabledFromDoc,
  ROOST_ENABLED_FIELD,
  roostDisabledResponse,
} from '@/lib/roostKillSwitch';

describe('isEnabledFromDoc', () => {
  it('null doc → enabled (fail-open)', () => {
    expect(isEnabledFromDoc(null)).toBe(true);
  });

  it('undefined doc → enabled', () => {
    expect(isEnabledFromDoc(undefined)).toBe(true);
  });

  it('empty doc (no field) → enabled (default)', () => {
    expect(isEnabledFromDoc({})).toBe(true);
  });

  it('explicit false → disabled', () => {
    expect(isEnabledFromDoc({ [ROOST_ENABLED_FIELD]: false })).toBe(false);
  });

  it('explicit true → enabled', () => {
    expect(isEnabledFromDoc({ [ROOST_ENABLED_FIELD]: true })).toBe(true);
  });

  it('non-boolean value → enabled (fail-open on type confusion)', () => {
    // Matches python: only the literal boolean false flips the switch, not the string "false".
    expect(isEnabledFromDoc({ [ROOST_ENABLED_FIELD]: 'false' })).toBe(true);
    expect(isEnabledFromDoc({ [ROOST_ENABLED_FIELD]: 0 })).toBe(true);
    expect(isEnabledFromDoc({ [ROOST_ENABLED_FIELD]: null })).toBe(true);
  });

  it('array doc → enabled (defensive)', () => {
    // typeof [] === 'object' leaks through without the Array.isArray guard.
    expect(isEnabledFromDoc([] as unknown as Record<string, unknown>)).toBe(true);
  });
});

describe('roostDisabledResponse', () => {
  it('returns a 503 problem+json with siteId in detail', async () => {
    const res = roostDisabledResponse('site-a');
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toMatch(/application\/problem\+json/);
    const body = await res.json();
    expect(body.status).toBe(503);
    expect(body.title).toBe('roost disabled');
    expect(body.detail).toMatch(/site-a/);
  });
});

describe('gateOrProceed', () => {
  it('returns null (pass-through) when enabled', async () => {
    const gated = await gateOrProceed('site-a', async () => ({
      [ROOST_ENABLED_FIELD]: true,
    }));
    expect(gated).toBeNull();
  });

  it('returns null when flag missing (fail-open default)', async () => {
    const gated = await gateOrProceed('site-a', async () => ({}));
    expect(gated).toBeNull();
  });

  it('returns 503 when explicitly disabled', async () => {
    const gated = await gateOrProceed('site-a', async () => ({
      [ROOST_ENABLED_FIELD]: false,
    }));
    expect(gated).not.toBeNull();
    expect(gated!.status).toBe(503);
  });

  it('fail-open on read exception (does not block deploys on blips)', async () => {
    const gated = await gateOrProceed('site-a', async () => {
      throw new Error('firestore offline');
    });
    expect(gated).toBeNull();
  });

  it('fail-open on null reader response', async () => {
    const gated = await gateOrProceed('site-a', async () => null);
    expect(gated).toBeNull();
  });
});

describe('contract with python side', () => {
  it('ROOST_ENABLED_FIELD constant is stable', () => {
    // Must match agent/src/roost_kill_switch.py's ROOST_ENABLED_FIELD — change both in ONE commit.
    expect(ROOST_ENABLED_FIELD).toBe('roostEnabled');
  });
});
