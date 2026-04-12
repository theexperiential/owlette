/**
 * POST /api/cortex/provision-key
 *
 * Provisions the LLM API key to a specific machine's local Cortex.
 * Writes a Firestore command that the service picks up, encrypts the key
 * with SecureStorage (Fernet), and stores it in config.json.
 *
 * Request body:
 *   - siteId: string
 *   - machineId: string
 *   - apiKey: string (the raw LLM API key)
 *   - provider: 'anthropic' | 'openai'
 *
 * Auth: requires authenticated user with site access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyUserSiteAccess } from '@/lib/cortex-utils.server';
import { apiError } from '@/lib/apiErrorResponse';

const COMMAND_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

export async function POST(request: NextRequest) {
  try {
    const userId = await requireSession(request);
    const body = await request.json();

    const { siteId, machineId, apiKey, provider } = body as {
      siteId: string;
      machineId: string;
      apiKey: string;
      provider: string;
    };

    if (!siteId || !machineId || !apiKey) {
      return NextResponse.json(
        { error: 'siteId, machineId, and apiKey are required' },
        { status: 400 },
      );
    }

    const db = getAdminDb();

    // Verify user access
    await verifyUserSiteAccess(db, userId, siteId);

    // Write command for the agent to pick up
    const commandId = `provision_cortex_key_${Date.now()}`;
    const pendingRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('pending');

    await pendingRef.set(
      {
        [commandId]: {
          type: 'provision_cortex_key',
          api_key: apiKey,
          provider: provider || 'anthropic',
          timestamp: FieldValue.serverTimestamp(),
          status: 'pending',
        },
      },
      { merge: true },
    );

    // Poll for completion
    const completedRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed');

    const startTime = Date.now();

    while (Date.now() - startTime < COMMAND_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const completedDoc = await completedRef.get();
      const cmdResult = completedDoc.data()?.[commandId];

      if (cmdResult) {
        // Clean up
        const { FieldValue } = await import('firebase-admin/firestore');
        await completedRef.update({ [commandId]: FieldValue.delete() });

        if (cmdResult.status === 'failed') {
          return NextResponse.json(
            { error: cmdResult.error || 'Key provisioning failed' },
            { status: 500 },
          );
        }

        return NextResponse.json({ success: true });
      }
    }

    // Timeout — clean up pending command
    try {
      const { FieldValue } = await import('firebase-admin/firestore');
      await pendingRef.update({ [commandId]: FieldValue.delete() });
    } catch {
      // Best effort
    }

    return NextResponse.json(
      { error: 'Key provisioning timed out — machine may be offline' },
      { status: 504 },
    );
  } catch (error: unknown) {
    return apiError(error, 'cortex/provision-key');
  }
}
