"use client"

import * as React from "react"
import { format, isValid, parse } from "date-fns"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface DatePickerProps {
  value?: Date
  onChange: (date: Date | undefined) => void
  placeholder?: string
  /** react-day-picker matcher for dates to disable (e.g. to keep `from` <= `to`). */
  disabled?: (date: Date) => boolean
  className?: string
  id?: string
}

/** Canonical text format the input displays + parses first. */
const INPUT_FORMAT = "yyyy-MM-dd"

/**
 * A themed date picker you can BOTH type into and pick from a calendar:
 *  - a text Input (canonical `yyyy-mm-dd`, but also tolerant of `5/24/2026`,
 *    `May 24 2026`, etc. on blur/Enter), and
 *  - a calendar-icon button that opens the shadcn Calendar in a Popover.
 * Replaces the browser-native <input type="date"> so the calendar matches the
 * app theme while keeping keyboard date entry.
 */
export function DatePicker({
  value,
  onChange,
  placeholder = "yyyy-mm-dd",
  disabled,
  className,
  id,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState(value ? format(value, INPUT_FORMAT) : "")

  // Keep the text field in sync when the value changes from the calendar or parent.
  React.useEffect(() => {
    setText(value ? format(value, INPUT_FORMAT) : "")
  }, [value])

  const commitText = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === "") {
      onChange(undefined)
      return
    }
    // Canonical format first, then a tolerant Date parse for other inputs.
    let parsed = parse(trimmed, INPUT_FORMAT, new Date())
    if (!isValid(parsed)) {
      const loose = new Date(trimmed)
      if (isValid(loose)) parsed = loose
    }
    if (isValid(parsed) && !disabled?.(parsed)) {
      onChange(parsed)
    } else {
      // Unparseable / disabled — revert the text to the last valid value.
      setText(value ? format(value, INPUT_FORMAT) : "")
    }
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        inputMode="numeric"
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commitText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commitText(e.currentTarget.value)
          } else if (e.key === "ArrowDown") {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className="pr-9"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="open calendar"
            className="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2 text-muted-foreground"
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            selected={value}
            onSelect={(date) => {
              onChange(date)
              setOpen(false)
            }}
            disabled={disabled}
            autoFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
