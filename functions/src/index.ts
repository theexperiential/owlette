/**
 * Owlette Cloud Functions
 *
 * - Metrics history aggregation
 * - Deployment status tracking (command completion → deployment doc updates)
 * - Stale deployment sweeper (catches agent crashes / timeouts)
 */

import * as admin from 'firebase-admin';

// Initialize Firebase Admin SDK
admin.initializeApp();

// Export all functions
export { onMetricsWrite } from './metricsHistory';
export { onCommandCompleted } from './deploymentStatus';
export { sweepStaleDeployments } from './deploymentSweeper';
export { onRoostWritten, onTargetStateWritten } from './distributionFanout';
export { verifyChunk } from './chunkVerify';
export { chunkGcNightly } from './chunkGc';
export { preUploadCheck, reconcileQuota } from './quotaEnforce';
export {
  aggregateTelemetry,
  getUsageSummaryHttp,
  recordUsageEvent,
} from './telemetry';
export {
  exportAuditDaily,
  recordAuditEvent,
  verifyAuditChain,
} from './auditLog';
export { exportSecurityBoundaryAuditDevDaily } from './securityBoundaryAuditExport';
export { emitWebhook, processRetryQueue } from './webhookDispatch';
export { sweepExpiredApiKeysDaily } from './apiKeyExpire';
export { sweepExpiredIdempotencyCacheDaily } from './idempotencyCleanup';
// reconcileDeploymentStatus / reconcileDistributionStatus (wave-2.4) removed
// 2026-05-30: both triggered on commands/pending, but the agent only ever
// writes command status to commands/completed, so they never fired (inert).
// onCommandCompleted (deploymentStatus.ts, on commands/completed) is the
// canonical deployment reconciler. v1 project-distribution is deprecated (roost).
