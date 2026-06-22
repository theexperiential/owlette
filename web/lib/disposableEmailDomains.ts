/**
 * disposableEmailDomains — curated blocklist of throwaway / temp-mail
 * providers used to gate self-serve signup (see /api/users/bootstrap).
 *
 * Scope: KNOWN burner-mail providers only. We deliberately DON'T list
 * mainstream consumer providers (gmail, outlook, yahoo, proton, icloud,
 * gmx, fastmail, zoho, and yandex / `ya.ru`) — those are where real users
 * live. The spam wave that motivated this used `ya.ru` (legitimate Yandex),
 * which is exactly why a domain blocklist is only defence-in-depth, not the
 * primary control: the display-name sanitiser + per-IP signup rate limit do
 * the heavy lifting against that vector.
 *
 * Matching is EXACT domain (the part after the last `@`, lowercased). We
 * avoid suffix matching on purpose — it would risk false positives against
 * lookalike legitimate domains, and an inert orphaned Firebase Auth account
 * (no Firestore doc → no access, invisible in the admin table) is the cost
 * of a false rejection here, so we keep the list explicit and conservative.
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

/**
 * True if `email`'s domain is a known disposable / throwaway provider.
 * Returns false for malformed input (the caller validates format
 * separately) so this never masks a missing format check.
 */
export function isDisposableEmailDomain(email: string): boolean {
  if (typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
