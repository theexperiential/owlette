/**
 * MENU_SURFACE — app-wide treatment for floating menu panels, ported verbatim
 * from `web/components/PageHeader.tsx` so desktop popovers/dropdowns read as the
 * same object as their web counterparts. Shared here rather than retyped per
 * call site.
 *
 * Usage: `<DropdownMenuContent className={`${MENU_SURFACE} w-56`}>`
 */
export const MENU_SURFACE =
  'border-border bg-secondary/85 backdrop-blur-sm shadow-2xl shadow-black/50 ring-1 ring-white/10'
