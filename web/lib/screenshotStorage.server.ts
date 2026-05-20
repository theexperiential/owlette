/**
 * Signed-URL helpers for the machine-api screenshot capture flow
 * (api-sprint wave 2 — track 2A).
 *
 * Two URL kinds, two TTLs:
 *
 *   - WRITE URLs (5 min) issued to the agent during a `capture_screenshot`
 *     command. The agent PUTs the captured image directly to the URL,
 *     bypassing the web tier so we never proxy a multi-MB binary through
 *     Next.js. Path: `screenshots/{siteId}/{machineId}/{timestamp}.png`.
 *
 *   - READ URLs (1 hour) re-issued every time the dashboard polls
 *     `GET /commands/{commandId}` and the underlying command has a
 *     `result.screenshot_path`. We never persist a read URL — minting per
 *     request guarantees expiry is honored.
 *
 * Retention: storage-side lifecycle rule deletes objects under
 * `screenshots/**` after 30 days. That rule lives in `storage.rules` /
 * the bucket's lifecycle policy and is intentionally out of scope here —
 * the route never has to enumerate or prune.
 *
 * Path shape: the timestamp segment is a Unix-millisecond integer
 * concatenated with a short random suffix to avoid collisions when two
 * captures land in the same ms (the agent calls upload-url once per
 * capture, so the random suffix is defense-in-depth).
 */
import crypto from 'crypto';
import { getAdminStorage } from '@/lib/firebase-admin';

const WRITE_URL_TTL_MS = 5 * 60 * 1000; // 5 minutes
const READ_URL_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CONTENT_TYPE = 'image/png';

export interface SignedWriteUrlResult {
  uploadUrl: string;
  storagePath: string;
  expiresAt: string;
}

export interface SignedReadUrlResult {
  url: string;
  expiresAt: string;
}

/**
 * Sniff the configured storage-bucket name. Mirrors the resolution path
 * used by `/api/agent/screenshot` so the two handlers always agree on
 * which bucket files land in.
 */
function resolveBucketName(): string {
  const explicit =
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    process.env.FIREBASE_STORAGE_BUCKET;
  if (!explicit || explicit.length === 0) {
    throw new Error(
      '[screenshotStorage] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured',
    );
  }
  return explicit;
}

/** Map a screenshot content-type to its file extension. */
function extForContentType(contentType: string): string {
  return contentType === 'image/jpeg' ? 'jpg' : 'png';
}

/**
 * Compose the canonical storage path for a freshly-captured screenshot.
 * The extension reflects the content-type so a JPEG body never sits at a
 * `.png` URL (browsers honor content-type, but a mismatched extension is
 * a foot-gun for anything that trusts the path — downloads, CDN sniffing,
 * manual inspection).
 *
 * Exposed (rather than inlined into `issueScreenshotUploadUrl`) so tests +
 * the upload-url route can independently construct the path when
 * re-issuing read URLs without round-tripping through the storage SDK.
 */
export function buildScreenshotPath(
  siteId: string,
  machineId: string,
  contentType: string = DEFAULT_CONTENT_TYPE,
): string {
  const ts = Date.now();
  const suffix = crypto.randomBytes(4).toString('hex');
  return `screenshots/${siteId}/${machineId}/${ts}-${suffix}.${extForContentType(contentType)}`;
}

/**
 * Issue a 5-minute v4-signed PUT URL for the agent to upload directly to
 * Firebase Storage. The agent must send `Content-Type: image/png` (or the
 * `contentType` override returned alongside) — Storage signed URLs bind
 * the content-type at signing time.
 */
export async function issueScreenshotUploadUrl(
  siteId: string,
  machineId: string,
  contentType: string = DEFAULT_CONTENT_TYPE,
): Promise<SignedWriteUrlResult> {
  const storage = getAdminStorage();
  const bucket = storage.bucket(resolveBucketName());
  const storagePath = buildScreenshotPath(siteId, machineId, contentType);
  const file = bucket.file(storagePath);

  const expiresAt = new Date(Date.now() + WRITE_URL_TTL_MS);
  const [uploadUrl] = await file.getSignedUrl({
    action: 'write',
    version: 'v4',
    expires: expiresAt,
    contentType,
  });

  return {
    uploadUrl,
    storagePath,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Mint a 1-hour v4-signed GET URL for an existing storage path. Returns
 * `null` for a missing/blank path so callers can passthrough on commands
 * that have not yet completed (or that completed without a screenshot).
 */
export async function issueScreenshotReadUrl(
  storagePath: string | null | undefined,
): Promise<SignedReadUrlResult | null> {
  if (!storagePath || typeof storagePath !== 'string' || storagePath.length === 0) {
    return null;
  }
  const storage = getAdminStorage();
  const bucket = storage.bucket(resolveBucketName());
  const file = bucket.file(storagePath);

  const expiresAt = new Date(Date.now() + READ_URL_TTL_MS);
  const [url] = await file.getSignedUrl({
    action: 'read',
    version: 'v4',
    expires: expiresAt,
  });

  return {
    url,
    expiresAt: expiresAt.toISOString(),
  };
}
