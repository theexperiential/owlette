/**
 * Categorize and auto-title chat conversations using a cheap/fast LLM call.
 *
 * Single mode: POST { chatId, message, siteId }
 *   — Generates a short title + category for a new conversation.
 *
 * Batch mode: POST { chatIds, siteId }
 *   — Categorizes multiple existing conversations by reading their titles from Firestore.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { createCheapModel } from '@/lib/llm';
import { resolveLlmConfig, verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import {
  CHAT_CATEGORIES,
  buildTitleCategoryPrompt,
  categorizeNewChat,
  parseChatCategory,
} from '@/lib/hoot/categorizeChat.server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';
import { isUntitledChat } from '@/lib/hoot/untitledChat';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    const body = await request.json();
    const { siteId } = body;

    if (!siteId) {
      return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
    }

    const db = getAdminDb();
    await verifyUserSiteAccess(db, userId, siteId);
    const llmConfig = await resolveLlmConfig(db, userId, siteId);
    const model = createCheapModel(llmConfig);

    // Batch mode — categorize multiple existing conversations
    if (body.chatIds && Array.isArray(body.chatIds)) {
      const results: Record<string, string> = {};

      // Process in chunks of 5 to avoid rate limits
      const chunks: string[][] = [];
      for (let i = 0; i < body.chatIds.length; i += 5) {
        chunks.push(body.chatIds.slice(i, i + 5));
      }

      for (const chunk of chunks) {
        const promises = chunk.map(async (chatId: string) => {
          try {
            const chatDoc = await db.collection('chats').doc(chatId).get();
            const data = chatDoc.data();
            if (!chatDoc.exists || data?.siteId !== siteId) {
              console.warn(`[Categorize] Skipping chat ${chatId}: not found on site ${siteId}`);
              return;
            }

            // Skip conversations with no meaningful title — need at least
            // a real title (not "new conversation") or a first message to categorize
            const title = data?.title;
            if (isUntitledChat(title)) {
              // Try to read the first user message as fallback context
              const messagesSnap = await db.collection('chats').doc(chatId)
                .collection('messages')
                .where('role', '==', 'user')
                .orderBy('createdAt', 'asc')
                .limit(1)
                .get();
              const firstMsg = messagesSnap.docs[0]?.data()?.content;
              if (!firstMsg) {
                console.log(`[Categorize] Skipping chat ${chatId}: no title or messages`);
                return;
              }

              // Categorize + title from first message
              const { text } = await generateText({
                model,
                prompt: buildTitleCategoryPrompt(
                  typeof firstMsg === 'string' ? firstMsg.slice(0, 500) : JSON.stringify(firstMsg).slice(0, 500),
                ),
              });

              const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
              const newTitle = lines[0]?.slice(0, 80) || 'untitled';
              const category = lines[1] ? parseChatCategory(lines[1]) : 'General';
              await db.collection('chats').doc(chatId).update({ title: newTitle, category });
              results[chatId] = category;
              return;
            }

            const { text } = await generateText({
              model,
              prompt: `Categorize this IT/media-server management conversation into exactly one of: ${CHAT_CATEGORIES.join(', ')}.

Title: "${title}"

Reply with only the category name, nothing else.`,
            });

            const category = parseChatCategory(text);
            await db.collection('chats').doc(chatId).update({ category });
            results[chatId] = category;
          } catch (err) {
            console.error(`[Categorize] Failed for chat ${chatId}:`, err);
          }
        });
        await Promise.all(promises);
      }

      return NextResponse.json({ results });
    }

    // Single mode — generate title + category for a new conversation
    const { chatId, message } = body;
    if (!chatId || !message) {
      return NextResponse.json({ error: 'Missing chatId or message' }, { status: 400 });
    }

    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data()?.siteId !== siteId) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    // Generate title + category and write both to the chat document
    const { title, category } = await categorizeNewChat(db, model, chatId, message);

    return NextResponse.json({ title, category });
  } catch (error) {
    return apiError(error, 'hoot/categorize');
  }
}, { strategy: 'user', identifier: 'user', getUserId: getUserIdFromSession });
