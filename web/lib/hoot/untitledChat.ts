/**
 * The default title of a chat that has no user content yet.
 *
 * Client (useHoot's optimistic row), server (turnRunner's persist fallback),
 * and the categorize route must all agree on what "untitled" means, so the
 * vocabulary lives here — pure constants, importable from both sides.
 *
 * `UNTITLED_CHAT_TITLES` also carries the pre-rebrand default: chats persisted
 * before the hoot rename are titled 'new conversation' forever (stored data),
 * and every "is this chat untitled?" check must keep matching them.
 */
export const UNTITLED_CHAT_TITLE = 'new hoot';

export const UNTITLED_CHAT_TITLES: ReadonlySet<string> = new Set([
  UNTITLED_CHAT_TITLE,
  'new conversation',
]);

export function isUntitledChat(title: string | null | undefined): boolean {
  return !title || UNTITLED_CHAT_TITLES.has(title);
}
