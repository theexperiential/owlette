import { FilePlus2 } from 'lucide-react'

/**
 * Whole-window drop affordance. A framed edge, not a scrim — the list underneath
 * keeps its own empty-state highlight, which is the more specific hint.
 *
 * `pointer-events-none` is load-bearing: drop events come from the Tauri host,
 * so swallowing clicks would turn a stuck overlay into a locked app.
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
