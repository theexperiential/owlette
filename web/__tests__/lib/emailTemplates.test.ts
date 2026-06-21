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
  emailDataTable,
  wrapEmailLayout,
  buildDisplayDigestEmail,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';

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

describe('wrapEmailLayout — "manage alerts" link', () => {
  it('renders "manage alerts" + /settings/alerts only when an unsubscribe link is present', () => {
    const withUnsub = wrapEmailLayout('<p>x</p>', {
      unsubscribeUrl: 'https://dev.owlette.app/api/unsubscribe?token=t',
    });
    expect(withUnsub).toContain('manage alerts');
    expect(withUnsub).toContain('/settings/alerts');

    const without = wrapEmailLayout('<p>x</p>', {});
    expect(without).not.toContain('manage alerts');
  });
});
