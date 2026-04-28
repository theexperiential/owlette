/**
 * `roost.chat` — cortex chat noun (wave 3A).
 *
 *   POST   /api/cortex/conversations                  — create a conversation
 *   GET    /api/cortex/conversations                  — list conversations
 *   POST   /api/cortex/conversations/{conversationId} — append a message + stream the response
 *   PATCH  /api/cortex/conversations/{conversationId} — rename
 *   DELETE /api/cortex/conversations/{conversationId} — soft delete
 *
 * `send` consumes the AI-SDK v3 line-prefixed stream protocol the server
 * emits from `result.toUIMessageStreamResponse()`:
 *   `0:"<json-encoded delta>"\n` → text delta
 *   `d:{...}\n`                  → end-of-stream marker
 *   `3:"<error>"\n`              → upstream error frame
 *
 * It exposes both pull (async iterable of text deltas) and push (an
 * `onDelta` callback) styles so callers can pick whichever fits. The
 * function returns an object exposing the iterable plus a final
 * `complete()` promise that resolves with the full assembled assistant
 * reply once the stream ends.
 */
import { randomUUID } from 'crypto';
import type { RoostClient } from '../lib/client';
import { SDK_VERSION } from '../version';

/* --------------------------------------------------------------------- */
/*  types                                                                */
/* --------------------------------------------------------------------- */

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ConversationSummary {
  conversationId: string;
  title: string | null;
  siteId: string;
  machineId?: string;
  ownerUid: string;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
  messageCount: number;
}

export interface ListConversationsOptions {
  siteId?: string;
  pageSize?: number;
  pageToken?: string;
  includeDeleted?: boolean;
  ownerOnly?: boolean;
}

export interface ListConversationsResult {
  conversations: ConversationSummary[];
  nextPageToken: string;
}

export interface CreateConversationOptions {
  siteId: string;
  machineId?: string;
  title?: string;
  initialMessage?: { role: ChatRole; content: string };
  idempotencyKey?: string;
}

export interface CreateConversationResult {
  conversationId: string;
  title: string | null;
  siteId: string;
  machineId?: string;
  messages?: Array<{ role: ChatRole; content: string; timestamp?: string }>;
}

export interface SendMessageOptions {
  role?: ChatRole;
  machineId?: string;
  machineName?: string;
  /** Push-style callback — invoked once per text delta as it arrives. */
  onDelta?: (text: string) => void;
  /** Forwarded to the underlying fetch for cancellation. */
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface SendMessageStream {
  /** Async iterable of text deltas as they arrive. */
  deltas: AsyncIterable<string>;
  /**
   * Resolves to the fully assembled assistant text once the stream ends.
   * If the stream emits a `3:` error frame, this rejects with an Error
   * carrying the upstream message.
   */
  complete: Promise<string>;
}

/* --------------------------------------------------------------------- */
/*  resource                                                             */
/* --------------------------------------------------------------------- */

export class Chat {
  constructor(private readonly client: RoostClient) {}

  async new(opts: CreateConversationOptions): Promise<CreateConversationResult> {
    const body: Record<string, unknown> = { siteId: opts.siteId };
    if (opts.machineId !== undefined) body.machineId = opts.machineId;
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.initialMessage !== undefined) body.initial_message = opts.initialMessage;

    const res = await this.client.request<{
      ok: true;
      data: CreateConversationResult;
    }>('/api/cortex/conversations', {
      method: 'POST',
      body,
      idempotencyKey: opts.idempotencyKey ?? `sdk-chat-new-${randomUUID()}`,
    });
    // Tolerate raw + envelope shapes — the server returns
    // `{ ok, data: {...} }` but older fixtures sometimes hand the data
    // back at top-level.
    return (res.data.data ?? (res.data as unknown as CreateConversationResult));
  }

  async list(opts: ListConversationsOptions = {}): Promise<ListConversationsResult> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.siteId !== undefined) query.siteId = opts.siteId;
    if (opts.pageSize !== undefined) query.page_size = opts.pageSize;
    if (opts.pageToken !== undefined) query.page_token = opts.pageToken;
    if (opts.includeDeleted) query.includeDeleted = 'true';
    if (opts.ownerOnly) query.owner = 'me';

    const res = await this.client.request<{
      ok: true;
      data: ListConversationsResult;
    }>('/api/cortex/conversations', { query });
    return res.data.data ?? (res.data as unknown as ListConversationsResult);
  }

  async rename(
    conversationId: string,
    title: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ conversationId: string; title: string }> {
    const res = await this.client.request<{
      ok: true;
      data: { conversationId: string; title: string };
    }>(`/api/cortex/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: { title },
      idempotencyKey: opts.idempotencyKey ?? `sdk-chat-rename-${randomUUID()}`,
    });
    return res.data.data ?? (res.data as unknown as { conversationId: string; title: string });
  }

  async delete(
    conversationId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ conversationId: string; alreadyDeleted: boolean }> {
    const res = await this.client.request<{
      ok: true;
      data: { conversationId: string; alreadyDeleted: boolean };
    }>(`/api/cortex/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      idempotencyKey: opts.idempotencyKey ?? `sdk-chat-delete-${randomUUID()}`,
    });
    return (
      res.data.data ??
      (res.data as unknown as { conversationId: string; alreadyDeleted: boolean })
    );
  }

  /**
   * Send a message and stream the assistant's reply.
   *
   * Skips the SDK's normal `client.request` wrapper because it always
   * `await`s the full response body — incompatible with line-prefixed
   * streaming. Instead we go straight to `client._fetch`, attach the
   * standard auth/version headers ourselves, and decode the line-prefixed
   * AI-SDK protocol incrementally.
   */
  async send(
    conversationId: string,
    message: string,
    opts: SendMessageOptions = {},
  ): Promise<SendMessageStream> {
    const role: ChatRole = opts.role ?? 'user';
    const body: Record<string, unknown> = { role, content: message };
    if (opts.machineId !== undefined) body.machineId = opts.machineId;
    if (opts.machineName !== undefined) body.machineName = opts.machineName;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.client.token}`,
      'Roost-Version': this.client.roostVersion,
      'User-Agent': `@owlette/sdk (node-sdk) ${SDK_VERSION}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': opts.idempotencyKey ?? `sdk-chat-send-${randomUUID()}`,
    };

    const url = `${this.client.apiUrl}/api/cortex/conversations/${encodeURIComponent(conversationId)}`;
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
    if (opts.signal) init.signal = opts.signal;

    const response = await this.client._fetch(url, init);
    if (!response.ok) {
      // Try to surface the problem+json detail to the caller; fall back
      // to a generic message if parsing fails.
      let detail = `chat.send failed with http ${response.status}`;
      try {
        const text = await response.text();
        if (text) {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (typeof parsed.detail === 'string') detail = parsed.detail;
            else if (typeof parsed.title === 'string') detail = parsed.title;
          } catch {
            detail = text;
          }
        }
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }

    const body$ = response.body;
    if (!body$) {
      throw new Error('chat.send: response body is empty (cannot stream)');
    }

    return parseAiSdkStream(body$ as unknown as AsyncIterable<Uint8Array>, opts.onDelta);
  }
}

/* --------------------------------------------------------------------- */
/*  stream parser                                                        */
/* --------------------------------------------------------------------- */

function parseAiSdkStream(
  source: AsyncIterable<Uint8Array>,
  onDelta: ((text: string) => void) | undefined,
): SendMessageStream {
  const queue: string[] = [];
  let resolveNext: ((value: IteratorResult<string>) => void) | null = null;
  let rejectNext: ((reason: unknown) => void) | null = null;
  let done = false;
  let streamError: Error | null = null;
  const collected: string[] = [];

  let resolveComplete!: (text: string) => void;
  let rejectComplete!: (reason: unknown) => void;
  const complete = new Promise<string>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });

  const pushDelta = (text: string): void => {
    collected.push(text);
    if (onDelta) {
      try {
        onDelta(text);
      } catch (err) {
        // A throwing onDelta shouldn't kill the stream — surface as a stream
        // error which the iterator will rethrow on the next pull.
        streamError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r({ value: text, done: false });
    } else {
      queue.push(text);
    }
  };

  const finish = (): void => {
    done = true;
    if (streamError) {
      if (rejectNext) {
        const r = rejectNext;
        resolveNext = null;
        rejectNext = null;
        r(streamError);
      }
      rejectComplete(streamError);
      return;
    }
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r({ value: undefined, done: true });
    }
    resolveComplete(collected.join(''));
  };

  const consume = (line: string): void => {
    if (!line) return;
    if (line.startsWith('0:')) {
      try {
        const parsed = JSON.parse(line.slice(2));
        if (typeof parsed === 'string') pushDelta(parsed);
      } catch {
        // Drop malformed delta — never crash the stream.
      }
    } else if (line.startsWith('3:')) {
      let detail = line.slice(2);
      try {
        const parsed = JSON.parse(detail);
        if (typeof parsed === 'string') detail = parsed;
      } catch {
        /* keep raw */
      }
      streamError = new Error(`cortex stream error: ${detail}`);
    }
    // `d:` and any other prefix → ignore (end markers / tool frames).
  };

  // Drive the source asynchronously; the iterator below pulls from `queue`.
  (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for await (const chunk of source) {
        pending += decoder.decode(chunk, { stream: true });
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          consume(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
      if (pending.length > 0) consume(pending);
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err));
    } finally {
      finish();
    }
  })().catch((err) => {
    streamError = err instanceof Error ? err : new Error(String(err));
    finish();
  });

  const deltas: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            if (streamError) return Promise.reject(streamError);
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<string>>((resolve, reject) => {
            resolveNext = resolve;
            rejectNext = reject;
          });
        },
      };
    },
  };

  return { deltas, complete };
}
