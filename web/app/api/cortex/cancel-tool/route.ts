/**
 * Published-surface back-compat alias: /api/cortex/cancel-tool → /api/hoot/cancel-tool.
 *
 * The hoot rename moved these handlers to their canonical path. The shipped
 * `@owlette/cli` and the SDKs call the old path, and fleet agents may too, so
 * this file re-exports the real handlers rather than duplicating them. Do not
 * add logic here — see web/lib/hoot/WIRE_NAMES.md.
 */

export { POST } from '@/app/api/hoot/cancel-tool/route';
