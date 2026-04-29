/**
 * Scheduled managed Firestore export for W9 security-boundary audit logs.
 *
 * Cloud Scheduler cannot safely template a fresh date into the Firestore
 * Admin API request body. This scheduled function is the small wrapper that
 * generates a unique GCS prefix for each run and then starts exportDocuments.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';

const DEFAULT_PROJECT_ID = 'owlette-dev-3838a';
const DEV_BUCKET = 'gs://owlette-dev-security-boundary-audit-exports';
const COLLECTION_IDS = ['audit_log', 'entries'] as const;
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

interface MetadataTokenResponse {
  access_token?: string;
}

interface FirestoreExportOperation {
  name?: string;
  metadata?: unknown;
}

export function resolveProjectId(): string {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;

  const rawFirebaseConfig = process.env.FIREBASE_CONFIG;
  if (rawFirebaseConfig) {
    try {
      const parsed = JSON.parse(rawFirebaseConfig) as { projectId?: unknown };
      if (typeof parsed.projectId === 'string' && parsed.projectId.length > 0) {
        return parsed.projectId;
      }
    } catch {
      // Ignore malformed local config and use the explicit dev fallback below.
    }
  }

  return DEFAULT_PROJECT_ID;
}

export function resolveExportBucket(projectId = resolveProjectId()): string {
  if (process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET) {
    return process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET;
  }
  if (projectId === DEFAULT_PROJECT_ID) return DEV_BUCKET;
  throw new Error(
    'SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET is required outside owlette dev',
  );
}

export function resolveExportEnvironment(projectId = resolveProjectId()): string {
  if (process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_ENV) {
    return process.env.SECURITY_BOUNDARY_AUDIT_EXPORT_ENV;
  }
  return projectId === DEFAULT_PROJECT_ID ? 'dev' : 'prod';
}

export function formatExportTimestamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function buildOutputUriPrefix(date = new Date()): string {
  const projectId = resolveProjectId();
  const bucket = resolveExportBucket(projectId);
  const environment = resolveExportEnvironment(projectId);
  return `${bucket}/firestore/security-boundary-audit/${environment}/scheduled/${formatExportTimestamp(date)}`;
}

async function metadataAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`metadata token request failed: HTTP ${response.status} ${bodyText}`);
  }
  const body = JSON.parse(bodyText) as MetadataTokenResponse;
  if (!body.access_token) {
    throw new Error('metadata token response did not include access_token');
  }
  return body.access_token;
}

export async function startSecurityBoundaryAuditExport(
  outputUriPrefix = buildOutputUriPrefix(),
  fetchImpl: typeof fetch = fetch,
): Promise<FirestoreExportOperation> {
  const projectId = resolveProjectId();
  const token = await metadataAccessToken(fetchImpl);
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    '/databases/%28default%29:exportDocuments';

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      outputUriPrefix,
      collectionIds: [...COLLECTION_IDS],
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`firestore export failed: HTTP ${response.status} ${bodyText}`);
  }
  return JSON.parse(bodyText) as FirestoreExportOperation;
}

export const exportSecurityBoundaryAuditDevDaily = onSchedule(
  {
    schedule: '30 6 * * *',
    timeZone: 'UTC',
    timeoutSeconds: 120,
    memory: '256MiB',
    serviceAccount: `security-boundary-audit-export@${resolveProjectId()}.iam.gserviceaccount.com`,
  },
  async () => {
    const outputUriPrefix = buildOutputUriPrefix();
    const operation = await startSecurityBoundaryAuditExport(outputUriPrefix);
    console.log(
      `[securityBoundaryAuditExport] export started outputUriPrefix=${outputUriPrefix} operation=${operation.name ?? 'unknown'}`,
    );
  },
);
