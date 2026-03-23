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
