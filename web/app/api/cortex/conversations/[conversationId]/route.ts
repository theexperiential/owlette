/**
 * Published-surface back-compat alias: /api/cortex/conversations/{conversationId} → /api/hoot/conversations/{conversationId}.
 *
 * The hoot rename moved these handlers to their canonical path. The shipped
 * `@owlette/cli` and the SDKs call the old path, and fleet agents may too, so
 * this file re-exports the real handlers rather than duplicating them. Do not
 * add logic here — see web/lib/hoot/WIRE_NAMES.md.
 */

export { POST, PATCH, DELETE } from '@/app/api/hoot/conversations/[conversationId]/route';
