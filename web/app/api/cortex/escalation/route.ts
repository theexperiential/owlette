/**
 * POST /api/cortex/escalation
 *
 * Picks up escalation flags from Firestore cortex-events and sends
 * escalation emails via Resend. Called periodically by a cron or
 * triggered by the alert route.
 *
 * Auth: internal only (CORTEX_INTERNAL_SECRET header).
 *
 * Can also be called as GET for cron-style polling.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { escalate } from '@/lib/cortex-escalation.server';

/**
 * Process pending escalations for all sites.
 */
async function processEscalations(): Promise<{ processed: number; errors: number }> {
  const db = getAdminDb();
  let processed = 0;
  let errors = 0;

  // Query all cortex-events with escalationPending === true
  const sitesSnapshot = await db.collection('sites').get();

  for (const siteDoc of sitesSnapshot.docs) {
    const siteId = siteDoc.id;

    try {
      const pendingEvents = await db
        .collection('sites')
        .doc(siteId)
        .collection('cortex-events')
        .where('escalationPending', '==', true)
        .limit(10)
        .get();

      for (const eventDoc of pendingEvents.docs) {
        const data = eventDoc.data();
        try {
          const sent = await escalate(
            siteId,
            eventDoc.id,
            data.machineName || data.machineId || 'Unknown',
            data.processName || 'Unknown',
            data.summary || 'No summary available',
          );

          // Clear the flag regardless of email success
          await eventDoc.ref.update({
            escalationPending: false,
            escalationSent: sent,
            escalationProcessedAt: new Date(),
          });

          if (sent) {
            processed++;
          }
        } catch (err) {
          console.error(`[cortex/escalation] Failed to process event ${eventDoc.id}:`, err);
          errors++;
        }
      }
    } catch (err) {
      console.error(`[cortex/escalation] Failed to query events for site ${siteId}:`, err);
      errors++;
    }
  }

  return { processed, errors };
}

export async function POST(request: NextRequest) {
  // Authenticate with internal secret
  const secret = process.env.CORTEX_INTERNAL_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'Escalation endpoint not configured' },
      { status: 503 },
    );
  }

  const headerSecret = request.headers.get('x-cortex-secret');
  if (headerSecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await processEscalations();
  return NextResponse.json({ success: true, ...result });
}

/**
 * GET handler for cron-style polling.
 * Protected by CRON_SECRET env var.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const headerSecret = request.headers.get('authorization')?.replace('Bearer ', '');

  if (cronSecret && headerSecret !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await processEscalations();
  return NextResponse.json({ success: true, ...result });
}
