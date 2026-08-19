import { FilePlus2 } from 'lucide-react'

/**
 * "Let go and I will take that."
 *
 * The whole window is the drop target, so the whole window says so — a framed
 * edge rather than a dimming scrim, because the list underneath keeps its own
 * empty-state highlight and covering it up would hide the more specific hint
 * behind the more general one.
 *
 * `pointer-events-none` is load-bearing: Tauri's drop events come from the host,
 * not from the page, but a full-window element that swallowed clicks would make
 * a stuck overlay lock the app rather than just look wrong.
 */
export function DropOverlay() {
  return (
    <div
      aria-hidden
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary bg-primary/5"
    >
      <div className="flex items-center gap-2 rounded-full border border-primary/40 bg-background/95 px-4 py-2 shadow-lg">
        <FilePlus2 aria-hidden className="size-4 text-primary" />
        <span className="text-sm font-medium">drop to add a process</span>
      </div>
    </div>
  )
}
