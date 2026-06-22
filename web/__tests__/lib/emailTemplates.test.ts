/** @jest-environment node */

/**
 * Regression tests for alert-email HTML safety + the "manage alerts" footer.
 *
 * Stored-injection guard: alert emails now carry the site NAME (admin-settable
 * free text) and other operator-controlled values. They must be HTML-escaped
 * before interpolation so a malicious value can't render phishing markup in
 * emails sent to co-recipients.
 */

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/resendClient.server', () => ({
  ENV_LABEL: 'DEVELOPMENT',
  isProduction: false,
}));

import {
  escapeHtml,
  safeEmailSubject,
  emailDataTable,
  wrapEmailLayout,
  buildDisplayDigestEmail,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';

const displayAlert = (over: Partial<PendingDisplayAlert> = {}): PendingDisplayAlert => ({
  docId: 'd',
  siteId: 's',
  machineId: 'm',
  eventType: 'display_monitor_removed',
  data: {},
  agentVersion: '3.0.0',
  correlatedApplyId: '',
  timestamp: null,
  ...over,
});

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('leaves clean text untouched', () => {
    expect(escapeHtml('TEC (default_site)')).toBe('TEC (default_site)');
  });
});

describe('alert-email value escaping (stored-injection regression)', () => {
  it('emailDataTable escapes dynamic values', () => {
    const html = emailDataTable([{ label: 'site', value: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('buildDisplayDigestEmail escapes a malicious site name', () => {
    const alert: PendingDisplayAlert = {
      docId: 'd',
      siteId: 's',
      machineId: 'm',
      eventType: 'display_monitor_removed',
      data: {},
      agentVersion: '3.0.0',
      correlatedApplyId: '',
      timestamp: null,
    };
    const html = buildDisplayDigestEmail('<script>evil</script> (s)', [alert], undefined, 'UTC');
    expect(html).not.toContain('<script>evil');
    expect(html).toContain('&lt;script&gt;evil');
  });
});

describe('multi-alert display digest escaping', () => {
  it('escapes machineId in the multi-alert digest table (not just single-alert)', () => {
    const alerts = [
      displayAlert({ machineId: '<img src=x onerror=alert(1)>' }),
      displayAlert({ machineId: 'm2' }),
    ];
    const html = buildDisplayDigestEmail('TEC (s)', alerts, undefined, 'UTC');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('wrapEmailLayout — manage alerts / unsubscribe footer', () => {
  it('shows "manage alerts" on EVERY alert email — including the tokenless fallback (unsubscribeUrl undefined)', () => {
    // The fallback admin recipient has no per-user token, but must still get a
    // way to turn alerts off. The key being PRESENT (even undefined) marks an
    // alert email.
    const fallback = wrapEmailLayout('<p>x</p>', { unsubscribeUrl: undefined });
    expect(fallback).toContain('manage alerts');
    expect(fallback).toContain('/settings/alerts');
    expect(fallback).not.toContain('unsubscribe'); // no token → no one-click

    const withToken = wrapEmailLayout('<p>x</p>', {
      unsubscribeUrl: 'https://dev.owlette.app/api/unsubscribe?token=t',
    });
    expect(withToken).toContain('manage alerts');
    expect(withToken).toContain('unsubscribe');
  });

  it('does NOT show manage/unsubscribe on transactional emails (no unsubscribeUrl key)', () => {
    const transactional = wrapEmailLayout('<p>x</p>', { preheader: 'reset your password' });
    expect(transactional).not.toContain('manage alerts');
    expect(transactional).not.toContain('unsubscribe');
  });

  it('uses the simplified footer — no tagline, tridant attribution, or boilerplate', () => {
    const html = wrapEmailLayout('<p>x</p>', {
      unsubscribeUrl: 'https://dev.owlette.app/api/unsubscribe?token=t',
    });
    expect(html).not.toContain('attention is all you need');
    expect(html).not.toContain('is made by');
    expect(html).not.toContain('automated message');
    expect(html).toContain('owlette.app');
  });
});

describe('safeEmailSubject', () => {
  it('strips CR/LF/control chars, collapses whitespace, preserves hyphens', () => {
    expect(safeEmailSubject('offline in TEC-A4D\r\nBcc: evil@x')).toBe('offline in TEC-A4D Bcc: evil@x');
  });
  it('caps length at 200', () => {
    expect(safeEmailSubject('a'.repeat(500)).length).toBe(200);
  });
});
