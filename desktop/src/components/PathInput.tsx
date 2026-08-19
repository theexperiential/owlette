import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { middleTruncate } from '@/lib/middleTruncate'
import { cn } from '@/lib/utils'

/**
 * What is painted over a blurred field, and the geometry that makes it land
 * exactly where the field's own text would.
 */
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
 * A path field that shows the whole path when it can, and the two ends of it
 * when it cannot.
 *
 * A path is read from both ends — the drive and vendor at the front, the file
 * name at the back — and an input that overflows shows only the front. So a
 * field that is not being edited is painted over with
 * `C:/Program Files/…/TouchDesigner.exe`, sized to the box with the box's own
 * font.
 *
 * **The value is never touched.** An input cannot show one string and hold
 * another without the next keystroke saving the lie, so the truncation is an
 * overlay: the real text goes transparent, a span draws the short form on top,
 * and both disappear the moment the field takes focus. Everything that reads or
 * writes this field — the auto-save, the pickers, an external change arriving
 * from the web app — sees the full path throughout.
 *
 * The tooltip is the other half of the same idea: hovering a field whose text
 * does not fit reveals the whole value, and a field that fits never grows a
 * pointless one. That gate is the *presence* of the content, not a controlled
 * `open` — Radix owns opening and closing, so the tooltip behaves like every
 * other one in the app.
 */
export function PathInput({ className, onFocus, onBlur, ...props }: ComponentProps<typeof Input>) {
  /** Whether the field's own text overflows its box — measured on hover. */
  const [overflowing, setOverflowing] = useState(false)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Read by the measuring effect, which must not run against a field the
  // operator is in the middle of typing into.
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
    // `clientWidth` is zero before the first layout, and in any environment that
    // does not lay one out at all — a test renderer, most of all. Both mean "we
    // cannot know what fits", and showing the untouched value is the right
    // answer for both. Checked before anything is measured, so a run with no
    // layout never even asks for a canvas.
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

    // The pane is resizable, so the box this had to fit changes without the
    // value changing. ResizeObserver is in every webview this ships to; it is
    // guarded for the test environment, which has no layout to observe anyway.
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
              // Unmounting the content is what keeps a tooltip from popping over
              // the field being typed in; the next hover measures again.
              setOverflowing(false)
              onFocus?.(event)
            }}
            onBlur={(event) => {
              focused.current = false
              onBlur?.(event)
              // After the caller's handler: a blur is what commits an edit, and
              // what is measured has to be the value that was saved.
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
      {/*
        Rendered only for a value that does not fit. A tooltip that repeats a
        path already fully on screen is noise — and this is how that is said,
        rather than by driving Radix's `open` from here: a controlled tooltip
        opened programmatically never enters Radix's own hover state, so the
        very next thing Radix does is ask to close it again. The result was a
        tooltip that flashed and vanished under a stationary cursor. Uncontrolled,
        it stays up exactly as long as the pointer is on the field.
      */}
      {overflowing && (
        <TooltipContent className="max-w-[min(48rem,calc(100vw-4rem))] font-mono text-xs break-all">
          {value}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
