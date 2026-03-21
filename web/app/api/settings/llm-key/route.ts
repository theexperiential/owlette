/**
 * User-level LLM API key management.
 *
 * POST: Store/update encrypted API key
 * GET: Check if key exists (never returns the key itself)
 * DELETE: Remove stored API key
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { encryptApiKey, isLlmEncryptionConfigured } from '@/lib/llm-encryption.server';
import { type LlmProvider } from '@/lib/llm';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);

      if (!isLlmEncryptionConfigured()) {
        return NextResponse.json(
          { error: 'LLM encryption is not configured on the server' },
          { status: 500 }
        );
      }

      const body = await request.json();
      const { provider, apiKey, model } = body as {
        provider: LlmProvider;
        apiKey: string;
        model?: string;
      };

      if (!provider || !apiKey) {
        return NextResponse.json(
          { error: 'provider and apiKey are required' },
          { status: 400 }
        );
      }

      if (!['anthropic', 'openai'].includes(provider)) {
        return NextResponse.json(
          { error: 'Invalid provider. Must be "anthropic" or "openai"' },
          { status: 400 }
        );
      }

      const db = getAdminDb();
      const encrypted = encryptApiKey(apiKey);

      await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .set(
          {
            provider,
            apiKeyEncrypted: encrypted,
            model: model || null,
            updatedAt: new Date(),
          },
          { merge: true }
        );

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      const status = (error as { status?: number }).status || 500;
      return NextResponse.json({ error: message }, { status });
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      const db = getAdminDb();

      const doc = await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .get();

      if (!doc.exists) {
        return NextResponse.json({ configured: false });
      }

      const data = doc.data()!;
      return NextResponse.json({
        configured: true,
        provider: data.provider,
        model: data.model || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      const status = (error as { status?: number }).status || 500;
      return NextResponse.json({ error: message }, { status });
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);

export const DELETE = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      const db = getAdminDb();

      await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .delete();

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      const status = (error as { status?: number }).status || 500;
      return NextResponse.json({ error: message }, { status });
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);
