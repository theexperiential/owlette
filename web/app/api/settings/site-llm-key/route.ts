/**
 * Site-level LLM API key management (admin only).
 *
 * POST: Store/update encrypted API key for a site
 * GET: Check if site key exists
 * DELETE: Remove site API key
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { requireAdmin } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { encryptApiKey, isLlmEncryptionConfigured } from '@/lib/llm-encryption.server';
import { type LlmProvider } from '@/lib/llm';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireAdmin(request);

      if (!isLlmEncryptionConfigured()) {
        return NextResponse.json(
          { error: 'LLM encryption is not configured on the server' },
          { status: 500 }
        );
      }

      const body = await request.json();
      const { siteId, provider, apiKey, model } = body as {
        siteId: string;
        provider: LlmProvider;
        apiKey: string;
        model?: string;
      };

      if (!siteId || !provider || !apiKey) {
        return NextResponse.json(
          { error: 'siteId, provider, and apiKey are required' },
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
        .collection('sites')
        .doc(siteId)
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
  { strategy: 'api', identifier: 'ip' }
);

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireAdmin(request);

      const { searchParams } = new URL(request.url);
      const siteId = searchParams.get('siteId');

      if (!siteId) {
        return NextResponse.json({ error: 'siteId is required' }, { status: 400 });
      }

      const db = getAdminDb();
      const doc = await db
        .collection('sites')
        .doc(siteId)
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
  { strategy: 'api', identifier: 'ip' }
);

export const DELETE = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireAdmin(request);

      const body = await request.json();
      const { siteId } = body as { siteId: string };

      if (!siteId) {
        return NextResponse.json({ error: 'siteId is required' }, { status: 400 });
      }

      const db = getAdminDb();
      await db
        .collection('sites')
        .doc(siteId)
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
  { strategy: 'api', identifier: 'ip' }
);
