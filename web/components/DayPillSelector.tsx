'use client';

import { useEffect, useRef, useState } from 'react';

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const FULL_NAMES: Record<DayKey, string> = {
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};
const SHORT_LABELS: Record<DayKey, string> = {
  mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat', sun: 'sun',
};
// Single-letter labels — Tuesday/Thursday and Saturday/Sunday share initials,
// but the title attribute disambiguates and matches the convention used in
// ScheduleEditor's pill variant.
const SINGLE_LABELS: Record<DayKey, string> = {
  mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S', sun: 'S',
};

interface DayPillSelectorProps {
  value: string[];
  onChange: (days: string[]) => void;
  /**
   * 'rect' = three-letter labels in rounded rectangles (default — used in RebootScheduleDialog)
   * 'pill' = single-letter labels in circles (used in ScheduleEditor blocks)
   */
  variant?: 'rect' | 'pill';
  /** Tailwind classes applied when a day is active. Defaults to a cyan style. */
  activeClassName?: string;
  /** Tailwind classes applied when a day is inactive. Has a sensible default. */
  inactiveClassName?: string;
  /** Smaller pills (used by ScheduleEditor's compact mode). */
  compact?: boolean;
  /** Disable click-drag (defaults to true on fine-pointer devices). */
  enableDragSelect?: boolean;
}

/**
 * Day-of-week toggle row used by both RebootScheduleDialog and ScheduleEditor.
 * Supports click-drag selection on desktop (mouseDown captures the new mode,
 * mouseEnter applies it across pills, window mouseUp ends the drag).
 */
export default function DayPillSelector({
  value,
  onChange,
  variant = 'rect',
  activeClassName,
  inactiveClassName,
  compact = false,
  enableDragSelect = true,
}: DayPillSelectorProps) {
  // Drag-select state. dragModeRef avoids re-render churn during drag.
  const [isDragging, setIsDragging] = useState(false);
  const dragModeRef = useRef<'add' | 'remove' | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Detect coarse pointers (touch) to skip drag wiring entirely.
  const [supportsDrag, setSupportsDrag] = useState(false);
  useEffect(() => {
    if (!enableDragSelect || typeof window === 'undefined') return;
    setSupportsDrag(window.matchMedia('(pointer: fine)').matches);
  }, [enableDragSelect]);

  // End drag on any mouseup, even outside the component.
  useEffect(() => {
    if (!isDragging) return;
    const handleUp = () => {
      setIsDragging(false);
      dragModeRef.current = null;
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [isDragging]);

  const setDay = (day: DayKey, mode: 'add' | 'remove') => {
    const current = valueRef.current;
    const has = current.includes(day);
    if (mode === 'add' && !has) onChange([...current, day]);
    else if (mode === 'remove' && has) onChange(current.filter((d) => d !== day));
  };

  const toggleDay = (day: DayKey) => {
    const current = valueRef.current;
    onChange(current.includes(day) ? current.filter((d) => d !== day) : [...current, day]);
  };

  const handleMouseDown = (day: DayKey, e: React.MouseEvent) => {
    if (!supportsDrag) {
      // Coarse pointer — just toggle on click via the onClick handler.
      return;
    }
    e.preventDefault(); // suppress focus + drag-select of text
    const wasSelected = valueRef.current.includes(day);
    const mode: 'add' | 'remove' = wasSelected ? 'remove' : 'add';
    dragModeRef.current = mode;
    setIsDragging(true);
    setDay(day, mode);
  };

  const handleMouseEnter = (day: DayKey) => {
    if (!isDragging || !dragModeRef.current) return;
    setDay(day, dragModeRef.current);
  };

  // For coarse pointers, we still need basic click toggling.
  const handleClick = (day: DayKey) => {
    if (supportsDrag) return; // mouseDown already handled it
    toggleDay(day);
  };

  // Variant styling
  const baseClasses =
    variant === 'pill'
      ? `${compact ? 'w-7 h-7 text-[10px]' : 'w-8 h-8 text-xs'} rounded-full font-medium transition-colors cursor-pointer flex items-center justify-center select-none`
      : `px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors select-none`;

  const defaultActive =
    variant === 'pill'
      ? 'bg-cyan-600 text-white'
      : 'bg-cyan-600 border-cyan-500 text-white';
  const defaultInactive =
    variant === 'pill'
      ? 'bg-muted text-muted-foreground hover:bg-muted/80'
      : 'bg-secondary border-border text-muted-foreground hover:text-white hover:border-accent';

  const activeCls = activeClassName ?? defaultActive;
  const inactiveCls = inactiveClassName ?? defaultInactive;
  const labels = variant === 'pill' ? SINGLE_LABELS : SHORT_LABELS;
  const gap = variant === 'pill' ? 'gap-1' : 'gap-1.5';

  return (
    <div className={`flex flex-wrap ${gap}`}>
      {DAYS.map((day) => {
        const isActive = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            onMouseDown={(e) => handleMouseDown(day, e)}
            onMouseEnter={() => handleMouseEnter(day)}
            onClick={() => handleClick(day)}
            className={`${baseClasses} ${isActive ? activeCls : inactiveCls}`}
            title={FULL_NAMES[day]}
          >
            {labels[day]}
          </button>
        );
      })}
    </div>
  );
}
