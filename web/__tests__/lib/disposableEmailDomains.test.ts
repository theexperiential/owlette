/**
 * @jest-environment node
 *
 * tests for web/lib/disposableEmailDomains.ts (signup-abuse hardening).
 */
import {
  DISPOSABLE_EMAIL_DOMAINS,
  isDisposableEmailDomain,
} from '@/lib/disposableEmailDomains';

describe('isDisposableEmailDomain', () => {
  it('flags a known disposable domain', () => {
    expect(isDisposableEmailDomain('bot@mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('x@guerrillamail.com')).toBe(true);
    expect(isDisposableEmailDomain('y@bit.example')).toBe(false);
  });

  it('is case-insensitive on the domain', () => {
    expect(isDisposableEmailDomain('Bot@MailInator.com')).toBe(true);
  });

  it('matches on the last @ (handles quoted local parts)', () => {
    expect(isDisposableEmailDomain('weird@local@yopmail.com')).toBe(true);
  });

  it('does NOT flag mainstream providers — including the ya.ru spam vector', () => {
    // The wave that motivated this used a *legitimate* Yandex address; a
    // domain blocklist is defence-in-depth only and must never block real
    // consumer providers.
    for (const domain of [
      'ya.ru',
      'yandex.ru',
      'gmail.com',
      'outlook.com',
      'proton.me',
      'icloud.com',
      'fastmail.com',
    ]) {
      expect(isDisposableEmailDomain(`user@${domain}`)).toBe(false);
    }
  });

  it('returns false for malformed / non-string input', () => {
    expect(isDisposableEmailDomain('no-at-sign')).toBe(false);
    expect(isDisposableEmailDomain('trailing@')).toBe(false);
    expect(isDisposableEmailDomain('')).toBe(false);
    // @ts-expect-error — exercising the runtime guard
    expect(isDisposableEmailDomain(undefined)).toBe(false);
  });

  it('keeps the blocklist lowercased and free of mainstream providers', () => {
    for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
      expect(domain).toBe(domain.toLowerCase());
    }
    expect(DISPOSABLE_EMAIL_DOMAINS.has('gmail.com')).toBe(false);
    expect(DISPOSABLE_EMAIL_DOMAINS.has('ya.ru')).toBe(false);
  });
});
