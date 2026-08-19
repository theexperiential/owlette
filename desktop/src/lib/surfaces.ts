/**
 * Shared surface recipes.
 *
 * MENU_SURFACE is the app-wide treatment for floating menu panels — the class
 * string is ported verbatim from the web app, where it lives as a module const
 * in `web/components/PageHeader.tsx` and is applied to every
 * `<DropdownMenuContent>` in the header. Popovers and dropdowns in the desktop
 * app must read as the same object as their web counterparts, so the recipe
 * lives here rather than being retyped per call site.
 *
 * Usage: `<DropdownMenuContent className={`${MENU_SURFACE} w-56`}>`
 */
export const MENU_SURFACE =
  'border-border bg-secondary/85 backdrop-blur-sm shadow-2xl shadow-black/50 ring-1 ring-white/10'
