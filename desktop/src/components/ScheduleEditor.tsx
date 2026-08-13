import { ChevronDown, ChevronUp, Clock, Minus, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { DayPillSelector } from '@/components/DayPillSelector'
import { WeekSummaryBar } from '@/components/WeekSummaryBar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ScheduleBlock } from '@/lib/owletteConfig'
import { BLOCK_COLORS, DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults'

/**
 * The schedule editor, ported from `web/components/ScheduleEditor.tsx`.
 *
 * The blocks editor and its time picker are the web's, unchanged — the two apps
 * write the same `schedules` array into the same `config.json`, and a second
 * dialect of the same editor is how the two would drift apart.
 *
 * What is composed *around* the editor is the web's process dialog
 * (`web/app/dashboard/components/ProcessDialog.tsx:223-248`): the week bar over
 * the block list, no preset bar. Presets live in Firestore, which this app
 * never reads.
 */

// ─── Time Picker ─────────────────────────────────────────────────────────────

/**
 * The web reads `userPreferences.timeFormat` off the auth context. There is no
 * account and no preferences store here, so the picker takes the same default
 * the web falls back to when a user has never chosen (`'12h'`).
 */
const USE_24H = false

interface TimePickerProps {
  value: string // "HH:MM" 24-hour format
  onChange: (value: string) => void
  compact?: boolean
}

function formatTimeDisplay(value: string, use24h: boolean): string {
  const [h, m] = value.split(':').map(Number)
  if (use24h) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

/** Parse typed time input into "HH:MM" 24h format. Returns null if unrecognizable.
 *
 * In 12h mode, a bare "H:MM" (no am/pm) inherits the am/pm of `currentHour24`
 * so editing "2:25 pm" to "3:25" stays in the afternoon instead of silently
 * jumping back to 3:25 AM.
 */
function parseTimeInput(input: string, use24h: boolean, currentHour24?: number): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ')

  // "H:MM" or "HH:MM" with optional am/pm — e.g. "9:30", "17:00", "5:00 pm"
  const colonMatch = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/)
  if (colonMatch) {
    let h = parseInt(colonMatch[1])
    const m = parseInt(colonMatch[2])
    const ampm = colonMatch[3]
    if (m > 59) return null
    if (ampm === 'pm' && h !== 12) h = Math.min(h + 12, 23)
    else if (ampm === 'am' && h === 12) h = 0
    else if (!ampm && !use24h && h >= 1 && h <= 12 && typeof currentHour24 === 'number') {
      const wasPM = currentHour24 >= 12
      if (wasPM && h !== 12) h += 12
      else if (!wasPM && h === 12) h = 0
    }
    if (h > 23) return null
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  // "Ham" / "Hpm" — e.g. "5pm", "9 am"
  const shortMatch = s.match(/^(\d{1,2})\s*(am|pm)$/)
  if (shortMatch) {
    let h = parseInt(shortMatch[1])
    const ampm = shortMatch[2]
    if (h > 12 || h < 1) return null
    if (ampm === 'pm' && h !== 12) h += 12
    else if (ampm === 'am' && h === 12) h = 0
    return `${h.toString().padStart(2, '0')}:00`
  }

  // "HHMM" compact — e.g. "1700", "900"
  const compactMatch = s.match(/^(\d{3,4})$/)
  if (compactMatch) {
    const n = parseInt(compactMatch[1])
    const h = Math.floor(n / 100)
    const m = n % 100
    if (h > 23 || m > 59) return null
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  return null
}

/**
 * Not exported, unlike the web's: its only other consumer there is the
 * dashboard's schedule popover, which has no counterpart in this app.
 */
function TimePicker({ value, onChange, compact }: TimePickerProps) {
  const use24h = USE_24H
  const [draft, setDraft] = useState<string | null>(null)

  const [h, m] = value.split(':').map(Number)

  const adjust = (deltaMinutes: number): string => {
    const total = (((h * 60 + m + deltaMinutes) % (24 * 60)) + 24 * 60) % (24 * 60)
    const newH = Math.floor(total / 60)
    const newM = total % 60
    const newValue = `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`
    onChange(newValue)
    return newValue
  }

  const commit = (text: string) => {
    const parsed = parseTimeInput(text, use24h, h)
    if (parsed) onChange(parsed)
    setDraft(null)
  }

  const displayed = formatTimeDisplay(value, use24h)
  const inputWidth = use24h ? 'w-14' : 'w-[4.5rem]'
  const inputPy = compact ? 'py-0.5 text-[11px]' : 'py-1 text-sm'

  return (
    <div className="flex items-center gap-0.5">
      <input
        type="text"
        value={draft ?? displayed}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(displayed)
          requestAnimationFrame(() => e.target.select())
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(60), use24h))
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(-60), use24h))
          }
        }}
        className={`${inputPy} ${inputWidth} rounded-md border border-border bg-background text-foreground font-medium text-center cursor-text outline-none focus:border-muted-foreground transition-colors`}
        title="type a time (e.g. 9:00, 5pm, 17:00) or use ↑↓ arrows"
      />
      <div className="flex flex-col">
        <button
          type="button"
          aria-label="+15 min"
          onMouseDown={(e) => {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(15), use24h))
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer leading-none py-px"
        >
          <ChevronUp className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          aria-label="-15 min"
          onMouseDown={(e) => {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(-15), use24h))
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer leading-none py-px"
        >
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  )
}

// ─── Reusable Schedule Blocks Editor ────────────────────────────────────────

interface ScheduleBlocksEditorProps {
  blocks: ScheduleBlock[]
  onChange: (blocks: ScheduleBlock[]) => void
  compact?: boolean
}

/** Get stable color index for a block, using its colorIndex or falling back to position */
function getBlockColorIndex(block: ScheduleBlock, position: number): number {
  return block.colorIndex ?? position
}

export function ScheduleBlocksEditor({ blocks, onChange, compact }: ScheduleBlocksEditorProps) {
  const updateBlock = (index: number, updated: ScheduleBlock) => {
    const next = [...blocks]
    next[index] = updated
    onChange(next)
  }

  const addBlock = () => {
    // Find the next unused colorIndex
    const usedColors = new Set(blocks.map((b) => b.colorIndex ?? -1))
    let nextColor = 0
    while (usedColors.has(nextColor)) nextColor++
    onChange([
      ...blocks,
      {
        colorIndex: nextColor,
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        ranges: [{ start: '09:00', stop: '17:00' }],
      },
    ])
  }

  const removeBlock = (index: number) => {
    onChange(blocks.filter((_, i) => i !== index))
  }

  const updateRange = (
    blockIndex: number,
    rangeIndex: number,
    field: 'start' | 'stop',
    value: string,
  ) => {
    const block = blocks[blockIndex]
    const ranges = [...block.ranges]
    ranges[rangeIndex] = { ...ranges[rangeIndex], [field]: value }
    updateBlock(blockIndex, { ...block, ranges })
  }

  const addRange = (blockIndex: number) => {
    const block = blocks[blockIndex]
    updateBlock(blockIndex, {
      ...block,
      ranges: [...block.ranges, { start: '09:00', stop: '17:00' }],
    })
  }

  const removeRange = (blockIndex: number, rangeIndex: number) => {
    const block = blocks[blockIndex]
    updateBlock(blockIndex, {
      ...block,
      ranges: block.ranges.filter((_, i) => i !== rangeIndex),
    })
  }

  const updateBlockName = (blockIndex: number, name: string) => {
    const block = blocks[blockIndex]
    updateBlock(blockIndex, { ...block, name: name || undefined })
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const color = BLOCK_COLORS[getBlockColorIndex(block, blockIndex) % BLOCK_COLORS.length]
        return (
          <div key={blockIndex} className="border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color.pill}`} />
                <input
                  type="text"
                  value={block.name || ''}
                  onChange={(e) => updateBlockName(blockIndex, e.target.value)}
                  placeholder={`block ${blockIndex + 1}`}
                  className="text-sm font-medium bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground/50 w-full min-w-0 outline-none focus:border-muted-foreground transition-colors"
                />
              </div>
              {blocks.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeBlock(blockIndex)}
                  aria-label={`remove block ${blockIndex + 1}`}
                  className="h-6 w-6 p-0 text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer flex-shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>

            {/* Day pills */}
            <DayPillSelector
              value={block.days}
              onChange={(days) => updateBlock(blockIndex, { ...block, days })}
              variant="pill"
              compact={compact}
              activeClassName={`${color.pill} ${color.pillText}`}
            />

            {/* Time ranges */}
            <div className="space-y-2">
              {block.ranges.map((range, rangeIndex) => {
                const isOvernight = range.start > range.stop
                return (
                  <div key={rangeIndex} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <TimePicker
                        value={range.start}
                        onChange={(v) => updateRange(blockIndex, rangeIndex, 'start', v)}
                        compact={compact}
                      />
                      <span className="text-muted-foreground text-xs">to</span>
                      <TimePicker
                        value={range.stop}
                        onChange={(v) => updateRange(blockIndex, rangeIndex, 'stop', v)}
                        compact={compact}
                      />
                      {isOvernight && (
                        <span className="text-[10px] font-medium text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-1.5 py-0.5 whitespace-nowrap">
                          +1 day
                        </span>
                      )}
                      {block.ranges.length > 1 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => removeRange(blockIndex, rangeIndex)}
                              aria-label="remove time range"
                              className="h-6 w-6 rounded-md text-muted-foreground hover:text-red-400 hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>remove time range</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {/* Add time range button on the last row */}
                      {rangeIndex === block.ranges.length - 1 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => addRange(blockIndex)}
                              aria-label="add time range"
                              className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>add time range</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    {isOvernight && (
                      <p className="text-[11px] text-amber-400/80 pl-0.5">
                        ends the following day — schedule days control when it <em>starts</em>
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      <Button
        variant="outline"
        size="sm"
        onClick={addBlock}
        className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <Plus className="h-3 w-3 mr-1" />
        add schedule block
      </Button>
    </div>
  )
}

// ─── Dialog Wrapper ─────────────────────────────────────────────────────────

/**
 * The blocks the editor opens with.
 *
 * A block missing either half is unusable — the editor would read `days` and
 * `ranges` off it, and the save filter drops it in any case — so a config
 * mangled by hand is treated as if it held nothing, which is the same fallback
 * the web takes for an entry with no schedules at all.
 */
function seedBlocks(schedules: ScheduleBlock[] | null | undefined): ScheduleBlock[] {
  const usable = (schedules ?? []).filter(
    (block) => Array.isArray(block?.days) && Array.isArray(block?.ranges),
  )
  return usable.length > 0 ? usable : DEFAULT_SCHEDULE
}

interface ScheduleEditorProps {
  open: boolean
  /** The windows on disk. Null, absent, or empty seeds the web's default. */
  schedules: ScheduleBlock[] | null | undefined
  onClose: () => void
  /** Called with the blocks to store. Only fires when `save schedule` is used. */
  onSave: (blocks: ScheduleBlock[]) => void
}

/**
 * Author one process's schedule windows.
 *
 * Mounted only while open, so the draft is seeded fresh every time — the same
 * arrangement (and the same reason) as the web's dialog. Cancelling, pressing
 * escape, or clicking away therefore throws the draft away and leaves
 * `config.json` untouched.
 */
export function ScheduleEditor({ open, schedules, onClose, onSave }: ScheduleEditorProps) {
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(() => seedBlocks(schedules))

  const handleSave = () => {
    // A block with no days, or none left with a time range, can never match —
    // the web drops those on save rather than storing something inert.
    onSave(blocks.filter((block) => block.days.length > 0 && block.ranges.length > 0))
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="schedule-editor">
        <DialogHeader>
          <DialogTitle>configure schedule</DialogTitle>
          <DialogDescription>
            the service runs this process during these windows and stops it outside them. times
            follow the site&apos;s timezone, or this machine&apos;s local time when it is not paired
            to one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-lg border border-blue-600/30 bg-blue-950/10 p-3">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-blue-400" />
            <span className="text-xs font-medium text-blue-400">schedule configuration</span>
          </div>
          <div className="mb-2 flex justify-center">
            <WeekSummaryBar schedules={blocks} tall />
          </div>
          <div className="max-h-[50vh] overflow-y-auto pr-1">
            <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} compact />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            cancel
          </Button>
          <Button onClick={handleSave}>save schedule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
