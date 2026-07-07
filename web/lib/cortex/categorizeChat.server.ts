/**
 * Auto-title + categorization for new Cortex conversations.
 *
 * Extracted from `app/api/cortex/categorize/route.ts` so the detached turn
 * runner (`turnRunner.server.ts`) can categorize new conversations directly —
 * a server-side runner cannot round-trip through the authenticated categorize
 * endpoint. The route keeps its auth/batch concerns and calls these helpers
 * for the shared generation logic.
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */

import { generateText, type LanguageModel } from 'ai';

export const CHAT_CATEGORIES = [
  'Performance',
  'Crashes',
  'Network',
  'Display',
  'Processes',
  'System Info',
  'Configuration',
  'General',
] as const;

export type ChatCategory = (typeof CHAT_CATEGORIES)[number];

export function parseChatCategory(text: string): ChatCategory {
  return (
    CHAT_CATEGORIES.find((c) => c.toLowerCase() === text.trim().toLowerCase()) || 'General'
  );
}

/**
 * Two-line title + category prompt shared by single mode, the batch-mode
 * first-message fallback, and the turn runner.
 */
export function buildTitleCategoryPrompt(message: string): string {
  return `You manage IT/media-server systems. Given this user question, respond with exactly two lines:
Line 1: A short title (max 6 words, no quotes) summarizing the topic
Line 2: One category from: ${CHAT_CATEGORIES.join(', ')}

User question: "${message}"

Example response:
CPU and memory stability check
Performance`;
}

/**
 * Generate a title + category for a new conversation from its first user
 * message and stamp them onto `chats/{chatId}`. The caller is responsible
 * for access checks and for providing an (already resolved) cheap model.
 */
export async function categorizeNewChat(
  db: FirebaseFirestore.Firestore,
  model: LanguageModel,
  chatId: string,
  message: string,
): Promise<{ title: string; category: ChatCategory }> {
  const { text } = await generateText({
    model,
    prompt: buildTitleCategoryPrompt(message),
  });

  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines[0]?.slice(0, 80) || message.slice(0, 100);
  const category = lines[1] ? parseChatCategory(lines[1]) : 'General';

  await db.collection('chats').doc(chatId).update({ title, category });

  return { title, category };
}
