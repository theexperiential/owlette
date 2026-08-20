/**
 * Model list from the LLM provider's API, so the model dropdown stays current
 * without a hardcoded list. GET uses the user's stored key; POST takes a key
 * inline for pre-save validation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { decryptApiKey } from '@/lib/llm-encryption.server';
import { type LlmProvider } from '@/lib/llm';
import { apiError } from '@/lib/apiErrorResponse';

interface ProviderModel {
  id: string;
  name: string;
}

/**
 * Provider rejected the user-supplied API key (401/403) — expected and
 * user-recoverable (revoked, expired, mistyped), so routes map it to a 4xx and
 * skip Sentry capture instead of logging a 500.
 */
class InvalidProviderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProviderKeyError';
  }
}

/** Fetch models from Anthropic's /v1/models endpoint. */
async function fetchAnthropicModels(apiKey: string): Promise<ProviderModel[]> {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.error?.message || `Anthropic API error: ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new InvalidProviderKeyError(message);
    }
    throw new Error(message);
  }

  const data = await res.json();
  return (data.data || [])
    .filter((m: { id: string }) => !m.id.includes('claude-2') && !m.id.includes('claude-3-0'))
    .map((m: { id: string; display_name?: string }) => ({
      id: m.id,
      name: m.display_name || m.id,
    }));
}

/** Fetch models from OpenAI's /v1/models endpoint. */
async function fetchOpenAIModels(apiKey: string): Promise<ProviderModel[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.error?.message || `OpenAI API error: ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new InvalidProviderKeyError(message);
    }
    throw new Error(message);
  }

  const data = await res.json();

  // OpenAI returns ALL models (embeddings, TTS, DALL-E, etc.) — filter to chat models
  const chatPrefixes = ['gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4', 'chatgpt'];
  return (data.data || [])
    .filter((m: { id: string }) => chatPrefixes.some((p) => m.id.startsWith(p)))
    .filter((m: { id: string }) => !m.id.includes('realtime') && !m.id.includes('audio') && !m.id.includes('search'))
    .map((m: { id: string }) => ({
      id: m.id,
      name: m.id,
    }))
    .sort((a: ProviderModel, b: ProviderModel) => a.id.localeCompare(b.id));
}

async function fetchModels(provider: LlmProvider, apiKey: string): Promise<ProviderModel[]> {
  switch (provider) {
    case 'anthropic':
      return fetchAnthropicModels(apiKey);
    case 'openai':
      return fetchOpenAIModels(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/** GET: Fetch models using the user's stored API key. */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      const provider = request.nextUrl.searchParams.get('provider') as LlmProvider | null;

      const db = getAdminDb();
      const doc = await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .get();

      if (!doc.exists) {
        return NextResponse.json({ error: 'No API key configured' }, { status: 404 });
      }

      const data = doc.data()!;
      const resolvedProvider = provider || data.provider;

      if (!resolvedProvider || !['anthropic', 'openai'].includes(resolvedProvider)) {
        return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
      }

      const apiKey = decryptApiKey(data.apiKeyEncrypted);
      const models = await fetchModels(resolvedProvider, apiKey);

      return NextResponse.json({ models });
    } catch (error: unknown) {
      // Expected 4xx, not a server fault — keep it out of Sentry.
      if (error instanceof InvalidProviderKeyError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return apiError(error, 'settings/llm-models GET');
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);

/** POST: Fetch models using a provided API key (before saving). */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireSession(request);

      const body = await request.json();
      const { provider, apiKey } = body as { provider: LlmProvider; apiKey: string };

      if (!provider || !apiKey) {
        return NextResponse.json({ error: 'provider and apiKey are required' }, { status: 400 });
      }

      if (!['anthropic', 'openai'].includes(provider)) {
        return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
      }

      const models = await fetchModels(provider, apiKey);
      return NextResponse.json({ models });
    } catch (error: unknown) {
      // An invalid key is the expected negative result here — 4xx, no Sentry.
      if (error instanceof InvalidProviderKeyError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return apiError(error, 'settings/llm-models POST');
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);
