import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { middleTruncate } from '@/lib/middleTruncate'
import { cn } from '@/lib/utils'

/** The painted-over text plus the geometry that lands it on the real text. */
interface Overlay {
  text: string
  /** The input's own padding and font, so the two cannot drift apart. */
  paddingLeft: number
  paddingRight: number
  font: string
}

/** One canvas for the whole app; measuring text does not need a DOM node. */
let sharedContext: CanvasRenderingContext2D | null | undefined

function textMeasurer(font: string): ((text: string) => number) | null {
  if (sharedContext === undefined) {
    sharedContext = document.createElement('canvas').getContext('2d')
  }
  if (!sharedContext) return null
  if (font) sharedContext.font = font
  return (text) => sharedContext?.measureText(text).width ?? 0
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * A path field that shows both ends of a path it cannot show whole — an
 * overflowing input shows only the front, but a path is read from both.
 *
 * **The value is never touched.** An input that displays one string and holds
 * another saves the lie on the next keystroke, so the truncation is an overlay:
 * the real text goes transparent and a span draws `C:/Program
 * Files/…/TouchDesigner.exe` on top, both gone on focus. Auto-save, pickers and
 * external changes all see the full path throughout.
 *
 * The tooltip is gated by the *presence* of its content, not a controlled
 * `open` — see the comment at its render site.
 */
export function PathInput({ className, onFocus, onBlur, ...props }: ComponentProps<typeof Input>) {
  /** Does the text overflow its box? Measured on hover. */
  const [overflowing, setOverflowing] = useState(false)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The measuring effect must not run against a field being typed into.
  const focused = useRef(false)

  const value = typeof props.value === 'string' ? props.value : ''

  const measure = useCallback(() => {
    const input = inputRef.current
    if (!input || focused.current || !value) {
      setOverlay(null)
      return
    }

    const style = getComputedStyle(input)
    const paddingLeft = pixels(style.paddingLeft)
    const paddingRight = pixels(style.paddingRight)
    // `clientWidth` is 0 before first layout and in a test renderer. Both mean
    // "we can't know what fits", so show the untouched value. Checked first, so
    // a layout-less run never asks for a canvas.
    const available = input.clientWidth - paddingLeft - paddingRight
    if (available <= 0) {
      setOverlay(null)
      return
    }

    const font = style.font || `${style.fontSize} ${style.fontFamily}`.trim()
    const measurer = textMeasurer(font)
    if (!measurer) {
      setOverlay(null)
      return
    }

    const text = middleTruncate(value, (candidate) => measurer(candidate) <= available)
    setOverlay(text === value ? null : { text, paddingLeft, paddingRight, font })
  }, [value])

  useEffect(() => {
    measure()

    // The pane resizes, so the box changes without the value changing. The
    // guard is for the test environment, which has no layout to observe.
    const input = inputRef.current
    if (!input || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(input)
    return () => observer.disconnect()
  }, [measure])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="relative flex min-w-0 flex-1 items-center"
          data-overflowing={overflowing || undefined}
          onPointerEnter={() => {
            const input = inputRef.current
            setOverflowing(!!input && input.scrollWidth > input.clientWidth)
          }}
        >
          <Input
            {...props}
            ref={inputRef}
            className={cn(className, overlay && 'text-transparent')}
            onFocus={(event) => {
              focused.current = true
              setOverlay(null)
              // Unmount the content so no tooltip pops over the field being
              // typed in; the next hover measures again.
              setOverflowing(false)
              onFocus?.(event)
            }}
            onBlur={(event) => {
              focused.current = false
              onBlur?.(event)
              // After the caller's handler — blur commits the edit, and we
              // must measure the value that was saved.
              measure()
            }}
          />
          {overlay && (
            <span
              aria-hidden
              data-testid="path-overlay"
              className="pointer-events-none absolute inset-y-0 flex items-center overflow-hidden whitespace-pre"
              style={{
                left: overlay.paddingLeft,
                right: overlay.paddingRight,
                font: overlay.font || undefined,
              }}
            >
              {overlay.text}
            </span>
          )}
        </div>
      </TooltipTrigger>
      {/* Rendered only when the value doesn't fit — expressed by presence
          rather than Radix's `open`, because a programmatically-opened tooltip
          never enters Radix's hover state and Radix immediately closes it
          again. That flashed and vanished under a stationary cursor. */}
      {overflowing && (
        <TooltipContent className="max-w-[min(48rem,calc(100vw-4rem))] font-mono text-xs break-all">
          {value}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
