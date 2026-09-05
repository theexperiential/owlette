/**
 * Webhook signing secrets, stored OUTSIDE the webhook document.
 *
 * They used to live on `sites/{siteId}/webhooks/{webhookId}` itself, whose read
 * rule is `canAccessSite(siteId)` — membership, no role term — so every member of
 * a site could read the HMAC secret straight out of Firestore and forge
 * deliveries that the customer's receiver would validate as authentic.
 * `firestore.rules` named this in the `talon_secrets` block ("do not repeat the
 * webhooks `signingSecret` client-read leak") and it stayed live regardless.
 *
 * They now live at `sites/{siteId}/webhook_secrets/{webhookId}`, which is
 * `allow read, write: if false` — reachable only through the Admin SDK. The
 * webhook document keeps its url, events, counters and rotation METADATA, so it
 * stays readable by site members and the dashboard listener is unaffected.
 *
 * No UI regressed in the move: the dashboard parsed `signingSecret` out of its
 * snapshot into a field it never rendered. A secret is shown exactly once, in the
 * create and rotate API responses, and is unrecoverable afterwards — rotate to get
 * a new one.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';

/** Subcollection holding one secret document per webhook. */
export const WEBHOOK_SECRETS_COLLECTION = 'webhook_secrets';

export interface WebhookSecrets {
  /** Current secret used to sign outgoing deliveries. */
  signingSecret: string | null;
  /** Prior secret, still honoured until `previousSecretValidUntil` on the webhook doc. */
  previousSigningSecret: string | null;
}

/** The secret document reference, exported so a caller can batch it with its own writes. */
export function webhookSecretRef(db: Firestore, siteId: string, webhookId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection(WEBHOOK_SECRETS_COLLECTION)
    .doc(webhookId);
}

/**
 * Read a webhook's secrets. Returns nulls rather than throwing when the document
 * is missing — a subscription created before the migration, or one whose secret
 * was never minted, must degrade to "cannot sign" rather than take a delivery
 * worker down.
 */
export async function readWebhookSecrets(
  siteId: string,
  webhookId: string,
  db?: Firestore,
): Promise<WebhookSecrets> {
  const database = db ?? getAdminDb();
  const snap = await webhookSecretRef(database, siteId, webhookId).get();
  const data = snap.exists ? snap.data() ?? {} : {};
  return {
    signingSecret:
      typeof data.signingSecret === 'string' && data.signingSecret
        ? data.signingSecret
        : null,
    previousSigningSecret:
      typeof data.previousSigningSecret === 'string' && data.previousSigningSecret
        ? data.previousSigningSecret
        : null,
  };
}

/** Mint or replace a webhook's current secret, optionally retaining the prior one. */
export async function writeWebhookSecret(
  siteId: string,
  webhookId: string,
  signingSecret: string,
  previousSigningSecret: string | null,
  db?: Firestore,
): Promise<void> {
  const database = db ?? getAdminDb();
  await webhookSecretRef(database, siteId, webhookId).set({
    signingSecret,
    previousSigningSecret,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Drop a webhook's secrets. Called when the subscription is hard-deleted; a
 * soft-delete leaves them in place so an in-flight retry can still sign.
 */
export async function deleteWebhookSecrets(
  siteId: string,
  webhookId: string,
  db?: Firestore,
): Promise<void> {
  const database = db ?? getAdminDb();
  await webhookSecretRef(database, siteId, webhookId).delete();
}
