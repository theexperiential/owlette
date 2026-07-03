/**
 * Pre-authorize a pairing phrase for the e2e site and print it as JSON.
 * The real agent installer redeems it via /ADD=<phrase>.
 *
 *   node e2e-machine/lib/preauthorize.mjs
 *   -> {"phrase":"...","siteId":"e2e-fullmachine","expiresInSec":600}
 */
import { seedSiteAndOwner, mintSessionCookie, generateAndAuthorizePhrase, SITE_ID } from './admin.mjs';

try {
  const password = await seedSiteAndOwner();
  const cookie = await mintSessionCookie(password);
  const { phrase, expiresInSec } = await generateAndAuthorizePhrase(cookie);
  process.stdout.write(JSON.stringify({ ok: true, phrase, siteId: SITE_ID, expiresInSec }));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
