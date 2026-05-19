/**
 * Canonical public Cortex per-conversation routes.
 *
 * POST   /api/cortex/conversations/{conversationId}  -> append a user message and stream
 * PATCH  /api/cortex/conversations/{conversationId}  -> rename
 * DELETE /api/cortex/conversations/{conversationId}  -> soft-delete
 *
 * The older /api/chat/{conversationId} route remains a compatibility alias.
 */

export { POST, PATCH, DELETE } from '@/app/api/chat/[conversationId]/route';
