/**
 * @jest-environment node
 *
 * tests for web/lib/dmcaLogic.ts (roost wave 0.2).
 */

import {
  evaluateStrike,
  rateLimitVerdict,
  RATE_LIMIT,
  STRIKE_EXPIRY_MS,
  validateNotice,
  type DmcaNoticeInput,
  type StrikeRecord,
} from '@/lib/dmcaLogic';

function validNotice(): DmcaNoticeInput {
  return {
    signature: 'Jane Complainant',
    copyrightedWork: 'Summer Show 2026 — "Neon Dreams" video installation',
    identifiedMaterial: 'sites/foo-gallery/roosts/lobby-01/manifests/abc123',
    complainant: {
      name: 'Jane Complainant',
      email: 'jane@studio.example',
      phone: '+1-555-0100',
      address: '123 Studio Lane, LA, CA 90001',
    },
    goodFaithBelief: true,
    accuracyAndPerjuryAttestation: true,
  };
}

/* --------------------------------------------------------------------- */
/*  validateNotice                                                       */
/* --------------------------------------------------------------------- */

describe('validateNotice', () => {
  it('accepts a fully-populated notice', () => {
    const r = validateNotice(validNotice());
    expect(r.elementsComplete).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('rejects missing signature', () => {
    const n = { ...validNotice(), signature: '' };
    const r = validateNotice(n);
    expect(r.elementsComplete).toBe(false);
    expect(r.missing).toContain('signature');
  });

  it('rejects missing copyrightedWork', () => {
    const n = { ...validNotice(), copyrightedWork: '   ' };
    expect(validateNotice(n).missing).toContain('copyrightedWork');
  });

  it('rejects missing identifiedMaterial', () => {
    const n = { ...validNotice(), identifiedMaterial: '' };
    expect(validateNotice(n).missing).toContain('identifiedMaterial');
  });

  it('rejects bad email format', () => {
    const n = validNotice();
    n.complainant.email = 'not-an-email';
    expect(validateNotice(n).missing).toContain('complainant.email');
  });

  it('rejects missing complainant address', () => {
    const n = validNotice();
    n.complainant.address = '';
    expect(validateNotice(n).missing).toContain('complainant.address');
  });

  it('rejects missing complainant name', () => {
    const n = validNotice();
    n.complainant.name = '';
    expect(validateNotice(n).missing).toContain('complainant.name');
  });

  it('requires goodFaithBelief = true (not just truthy)', () => {
    // a missing/false checkbox must fail closed — we need the attestation
    // literal to match the statute.
    const n1 = { ...validNotice(), goodFaithBelief: false };
    expect(validateNotice(n1).missing).toContain('goodFaithBelief');
    const n2 = { ...validNotice(), goodFaithBelief: undefined as unknown as boolean };
    expect(validateNotice(n2).missing).toContain('goodFaithBelief');
  });

  it('requires accuracyAndPerjuryAttestation = true', () => {
    const n = { ...validNotice(), accuracyAndPerjuryAttestation: false };
    expect(validateNotice(n).missing).toContain('accuracyAndPerjuryAttestation');
  });

  it('collects ALL missing fields, not just the first', () => {
    const n: Partial<DmcaNoticeInput> = {};
    const r = validateNotice(n);
    expect(r.elementsComplete).toBe(false);
    // signature, copyrightedWork, identifiedMaterial, complainant,
    // goodFaithBelief, accuracyAndPerjuryAttestation — six expected.
    expect(r.missing.length).toBeGreaterThanOrEqual(6);
    expect(r.missing).toEqual(
      expect.arrayContaining([
        'signature',
        'copyrightedWork',
        'identifiedMaterial',
        'complainant',
        'goodFaithBelief',
        'accuracyAndPerjuryAttestation',
      ]),
    );
  });

  it('rejects non-object complainant (defensive)', () => {
    const n = { ...validNotice(), complainant: 'string-not-object' as unknown as DmcaNoticeInput['complainant'] };
    expect(validateNotice(n).missing).toContain('complainant');
  });
});

/* --------------------------------------------------------------------- */
/*  evaluateStrike                                                       */
/* --------------------------------------------------------------------- */

const NOW = new Date('2026-04-20T00:00:00Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

describe('evaluateStrike', () => {
  it('first takedown → warning tier, count=1', () => {
    const r = evaluateStrike([], NOW);
    expect(r.tier).toBe('warning');
    expect(r.newCount).toBe(1);
    expect(r.nextAction).toBe('email_warning');
  });

  it('second takedown → suspension tier, count=2', () => {
    const prior: StrikeRecord[] = [{ at: daysAgo(30), noticeId: 'n1' }];
    const r = evaluateStrike(prior, NOW);
    expect(r.tier).toBe('suspension');
    expect(r.newCount).toBe(2);
    expect(r.nextAction).toBe('suspend_14_days');
  });

  it('third takedown → termination tier, count=3', () => {
    const prior: StrikeRecord[] = [
      { at: daysAgo(60), noticeId: 'n1' },
      { at: daysAgo(30), noticeId: 'n2' },
    ];
    const r = evaluateStrike(prior, NOW);
    expect(r.tier).toBe('termination');
    expect(r.newCount).toBe(3);
    expect(r.nextAction).toBe('terminate_account');
  });

  it('strikes older than 12 months do not count', () => {
    // 400 days ago — past the 365-day expiry
    const prior: StrikeRecord[] = [
      { at: daysAgo(400), noticeId: 'old1' },
      { at: daysAgo(390), noticeId: 'old2' },
    ];
    const r = evaluateStrike(prior, NOW);
    expect(r.tier).toBe('warning');
    expect(r.newCount).toBe(1);
  });

  it('cleared strikes (successful counter-notice) do not count', () => {
    const prior: StrikeRecord[] = [
      { at: daysAgo(30), noticeId: 'n1', cleared: true },
      { at: daysAgo(15), noticeId: 'n2', cleared: true },
    ];
    const r = evaluateStrike(prior, NOW);
    expect(r.tier).toBe('warning');
    expect(r.newCount).toBe(1);
  });

  it('mixed — expired + cleared + active → counts only actives', () => {
    const prior: StrikeRecord[] = [
      { at: daysAgo(400), noticeId: 'expired' },
      { at: daysAgo(30), noticeId: 'cleared', cleared: true },
      { at: daysAgo(10), noticeId: 'active' },
    ];
    const r = evaluateStrike(prior, NOW);
    expect(r.newCount).toBe(2);
    expect(r.tier).toBe('suspension');
  });

  it('boundary — strike exactly at 365-day line counts (inclusive)', () => {
    const prior: StrikeRecord[] = [
      { at: new Date(NOW.getTime() - STRIKE_EXPIRY_MS).toISOString(), noticeId: 'n1' },
    ];
    const r = evaluateStrike(prior, NOW);
    // exactly-at-the-boundary: with strict `<` it counts; matches the
    // code's `t < cutoff` guard which means `t === cutoff` is KEPT.
    expect(r.newCount).toBe(2);
  });

  it('ignores malformed timestamp entries defensively', () => {
    const prior: StrikeRecord[] = [
      { at: 'not-a-date', noticeId: 'n1' },
      { at: daysAgo(10), noticeId: 'n2' },
    ];
    const r = evaluateStrike(prior, NOW);
    expect(r.newCount).toBe(2); // only the valid one counted
  });

  it('beyond-3 strikes still reports termination (no unbounded escalation tier)', () => {
    const prior: StrikeRecord[] = [
      { at: daysAgo(60), noticeId: 'n1' },
      { at: daysAgo(45), noticeId: 'n2' },
      { at: daysAgo(30), noticeId: 'n3' },
    ];
    const r = evaluateStrike(prior, NOW);
    expect(r.tier).toBe('termination');
    expect(r.newCount).toBe(4);
  });
});

/* --------------------------------------------------------------------- */
/*  rateLimitVerdict                                                     */
/* --------------------------------------------------------------------- */

describe('rateLimitVerdict', () => {
  it('allows when under both caps', () => {
    expect(rateLimitVerdict({ emailCount: 1, ipCount: 1 }).allowed).toBe(true);
  });

  it('blocks with email_rate when email cap reached', () => {
    const r = rateLimitVerdict({
      emailCount: RATE_LIMIT.perEmailPerHour,
      ipCount: 1,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('email_rate');
  });

  it('blocks with ip_rate when ip cap reached', () => {
    const r = rateLimitVerdict({
      emailCount: 1,
      ipCount: RATE_LIMIT.perIpPerHour,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ip_rate');
  });

  it('email cap is more restrictive than ip cap (legit studio use-case)', () => {
    // per-email cap < per-ip cap so a single complainant flooding
    // from many IPs still hits the email limit first.
    expect(RATE_LIMIT.perEmailPerHour).toBeLessThan(RATE_LIMIT.perIpPerHour);
  });
});
