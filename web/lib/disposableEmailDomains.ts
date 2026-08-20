/**
 * Throwaway / temp-mail providers blocked at self-serve signup
 * (/api/users/bootstrap).
 *
 * KNOWN burner providers only — never mainstream consumer domains. The spam wave
 * that motivated this came through `ya.ru` (legitimate Yandex), which is why this
 * is defence-in-depth: the display-name sanitiser and per-IP signup limit are the
 * primary controls.
 *
 * EXACT domain match (after the last `@`, lowercased). No suffix matching — it
 * would false-positive on lookalike legitimate domains, and the cost of a wrong
 * block is a real user turned away.
 */

export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'tempmail.plus',
  'tempr.email',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'sharklasers.com',
  'grr.la',
  'mailinator.com',
  'mailinator.net',
  'maildrop.cc',
  'mailnesia.com',
  'mailcatch.com',
  'mailsac.com',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'trashmail.com',
  'trashmail.de',
  'yopmail.com',
  'yopmail.net',
  'yopmail.fr',
  'throwawaymail.com',
  'fakeinbox.com',
  'spam4.me',
  'spambox.us',
  'mintemail.com',
  'mohmal.com',
  'emailondeck.com',
  'moakt.com',
  'burnermail.io',
  '33mail.com',
  'pokemail.net',
  'mailpoof.com',
  'vomoto.com',
  'inboxbear.com',
  'mvrht.net',
]);

/** False on malformed input, so this never masks the caller's missing format check. */
export function isDisposableEmailDomain(email: string): boolean {
  if (typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
