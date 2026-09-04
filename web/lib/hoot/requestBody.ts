/**
 * Pure request-body builder for the hoot chat transport.
 *
 * A send must be addressed by the chat instance that issued it, not by
 * whatever the UI currently shows: `@ai-sdk/react` recreates its Chat when the
 * id changes WITHOUT aborting the old instance's request, and an orphaned
 * instance still auto-resumes (`sendAutomaticallyWhen`) when its response
 * finishes. Built from live refs, such a follow-up would POST the OLD
 * conversation's messages under the NEW chatId — retargeting (and on a full
 * replace, overwriting) a different conversation.
 *
 * So: the transport's `id` (the issuing Chat instance's chatId) is
 * authoritative. A request whose `id` no longer matches the active chat
 * throws — the orphan's send dies in the browser instead of reaching the
 * server. Site/machine context is the value pinned when that chat was started
 * or loaded, falling back to the live context only when no pin exists (the
 * initial mount's chat, pinned lazily on first use).
 *
 * Kept pure and separate from useHoot for direct unit testing.
 */

export interface HootChatContext {
  siteId: string;
  machineId: string;
  machineName: string;
}

export class StaleChatInstanceError extends Error {
  constructor(transportChatId: string, activeChatId: string) {
    super(
      `stale chat instance: request addressed to conversation ${transportChatId} ` +
        `but the active conversation is ${activeChatId} — dropped to prevent ` +
        `cross-chat delivery`,
    );
    this.name = 'StaleChatInstanceError';
  }
}

export function buildHootRequestBody(args: {
  /** The id the SDK transport hands over — the issuing Chat instance's chatId. */
  transportChatId: string | undefined;
  /** The chat the UI currently considers active (chatIdRef). */
  activeChatId: string;
  /** Context pinned when the chat was started/loaded; null when never pinned. */
  pinnedContext: HootChatContext | null;
  /** Live UI context — fallback for the never-pinned initial chat only. */
  liveContext: HootChatContext;
  messages: unknown;
  supersede: boolean;
}): { body: Record<string, unknown> } {
  const { transportChatId, activeChatId, pinnedContext, liveContext, messages, supersede } = args;

  if (transportChatId !== undefined && transportChatId !== activeChatId) {
    throw new StaleChatInstanceError(transportChatId, activeChatId);
  }

  const context = pinnedContext ?? liveContext;
  return {
    body: {
      messages,
      siteId: context.siteId,
      machineId: context.machineId,
      machineName: context.machineName,
      chatId: transportChatId ?? activeChatId,
      ...(supersede ? { supersede: true } : {}),
    },
  };
}
