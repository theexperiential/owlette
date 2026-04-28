/**
 * Canonical public Cortex conversation collection.
 *
 * GET  /api/cortex/conversations  -> list conversations
 * POST /api/cortex/conversations  -> create a conversation
 *
 * The older /api/chat and /api/chat/new routes remain compatibility aliases.
 */

export { GET } from '@/app/api/chat/route';
export { POST } from '@/app/api/chat/new/route';
