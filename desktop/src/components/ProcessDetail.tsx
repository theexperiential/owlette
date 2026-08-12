import { FileSearch, FolderOpen, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { pickDirectory, pickExecutable, pickFile } from '@/lib/pickers'
import {
  coerceForm,
  formFromProcess,
  formsEqual,
  launchModeOf,
  priorityOf,
  PRIORITIES,
  scheduleSummary,
  VISIBILITIES,
  visibilityOf,
  type LaunchMode,
  type Priority,
  type ProcessEntry,
  type ProcessForm,
  type TextField,
  type Visibility,
} from '@/lib/owletteConfig'
import { STATUS_TEXT, statusLabel, type ProcessStatus } from '@/lib/processStatus'
import { cn } from '@/lib/utils'

/**
 * Enter and blur both fire for a single "I'm done typing", and the legacy GUI
 * drops the second within 100 ms rather than writing the file twice
 * (`owlette_gui.py:867-871`).
 */
const SAVE_DEBOUNCE_MS = 100

const LAUNCH_MODES: { value: LaunchMode; label: string }[] = [
  { value: 'off', label: 'off' },
  { value: 'always', label: 'always on' },
  { value: 'scheduled', label: 'scheduled' },
]

interface ProcessDetailProps {
  process: ProcessEntry
  status: ProcessStatus
  /** Persist the seven text fields. Already coerced; the caller only writes. */
  onSave: (form: ProcessForm) => void
  onLaunchMode: (mode: LaunchMode) => void
  onPriority: (priority: Priority) => void
  onVisibility: (visibility: Visibility) => void
  onRestart: () => void
  onKill: () => void
}

/**
 * The detail form for one process.
 *
 * Two behaviours here are worth more than they look:
 *
 * **Auto-save.** There is no save button. A field writes itself to
 * `config.json` when it loses focus or takes an enter key, but only if it
 * actually differs from what is on disk — otherwise merely tabbing through the
 * form would rewrite the file, and every rewrite makes the service re-read and
 * re-upload the config.
 *
 * **Deferred external refresh.** The web app and the service write this same
 * file. When one of them changes the selected process the panel takes the new
 * values immediately — except for a field the operator is typing in, which
 * would be intolerable to have change under the cursor. That field keeps its
 * text and picks up the change when focus leaves (`owlette_gui.py:1434-1448`).
 */
export function ProcessDetail({
  process,
  status,
  onSave,
  onLaunchMode,
  onPriority,
  onVisibility,
  onRestart,
  onKill,
}: ProcessDetailProps) {
  const [draft, setDraft] = useState<ProcessForm>(() => formFromProcess(process))
  const [pendingRefresh, setPendingRefresh] = useState(false)

  // The values last known to be on disk, so an incoming document can be told
  // apart from the echo of our own write.
  const synced = useRef<ProcessForm>(formFromProcess(process))
  // What the draft was seeded with. The draft differing from *this* is the only
  // proof the operator typed something — it will also differ from what is on
  // disk whenever an external change is being held back.
  const seeded = useRef<ProcessForm>(formFromProcess(process))
  const shownId = useRef(process.id)
  const focused = useRef<TextField | null>(null)
  const lastSaveAt = useRef(0)
  const lastSaved = useRef<ProcessForm | null>(null)
  const latest = useRef(process)

  const mode = launchModeOf(process)

  useEffect(() => {
    latest.current = process
    const next = formFromProcess(process)

    // A different process is on screen: adopt it wholesale, cursor or not.
    if (shownId.current !== process.id) {
      shownId.current = process.id
      synced.current = next
      seeded.current = next
      lastSaved.current = null
      focused.current = null
      setPendingRefresh(false)
      setDraft(next)
      return
    }

    if (formsEqual(next, synced.current)) return

    synced.current = next
    if (focused.current) {
      setPendingRefresh(true)
    } else {
      seeded.current = next
      setDraft(next)
    }
  }, [process])

  /** Write `form` if it says something new. Returns whether it wrote. */
  const save = useCallback(
    (form: ProcessForm): boolean => {
      const coerced = coerceForm(form)

      // The one field a soft save will not blank: an entry with no name cannot
      // be found again in the list.
      if (!coerced.name) return false

      const onDisk = formFromProcess(latest.current)
      if (formsEqual(coerced, onDisk)) {
        // Nothing to write — but what was typed may not be what will be stored
        // (a two-second initialise time is floored to ten), so the form has to
        // stop showing a value the file does not hold.
        seeded.current = onDisk
        setDraft(onDisk)
        return false
      }

      const now = Date.now()
      if (
        lastSaved.current &&
        formsEqual(coerced, lastSaved.current) &&
        now - lastSaveAt.current < SAVE_DEBOUNCE_MS
      ) {
        return false
      }

      lastSaveAt.current = now
      lastSaved.current = coerced
      synced.current = coerced
      seeded.current = coerced
      setDraft(coerced)
      onSave(coerced)
      return true
    },
    [onSave],
  )

  const handleBlur = useCallback(() => {
    focused.current = null

    // An edit the operator made outranks a change that arrived while they were
    // making it — last writer wins, and they are the one holding the keyboard.
    if (!formsEqual(draft, seeded.current)) {
      save(draft)
      setPendingRefresh(false)
      return
    }

    if (pendingRefresh) {
      const onDisk = formFromProcess(latest.current)
      synced.current = onDisk
      seeded.current = onDisk
      setDraft(onDisk)
      setPendingRefresh(false)
    }
  }, [draft, pendingRefresh, save])

  const browse = useCallback(
    async (field: 'exe_path' | 'file_path' | 'cwd') => {
      try {
        const picked =
          field === 'exe_path'
            ? await pickExecutable(draft.exe_path)
            : field === 'file_path'
              ? await pickFile(draft.file_path)
              : await pickDirectory(draft.cwd)

        if (picked === null) return
        const next = { ...draft, [field]: picked }
        setDraft(next)
        save(next)
      } catch (cause) {
        toast.error('could not open the file picker', {
          description: cause instanceof Error ? cause.message : String(cause),
        })
      }
    },
    [draft, save],
  )

  function field(name: TextField) {
    return {
      value: draft[name],
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((current) => ({ ...current, [name]: event.target.value })),
      onFocus: () => {
        focused.current = name
      },
      onBlur: handleBlur,
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return
        save(draft)
        event.currentTarget.blur()
      },
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 px-6 pt-4 pb-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">process details</h2>
          <span className={cn('text-xs', STATUS_TEXT[status])} data-testid="detail-status">
            {statusLabel(status)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" onClick={onRestart} aria-label="restart process">
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>restart — stop it and let the service bring it back</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" onClick={onKill} aria-label="kill process">
                <Square />
              </Button>
            </TooltipTrigger>
            <TooltipContent>kill — terminate it now, without a crash alert</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          <Label htmlFor="launch-mode" className="justify-end text-muted-foreground">
            launch mode
          </Label>
          <div className="flex min-w-0 items-center gap-3">
            <Select value={mode} onValueChange={(value) => onLaunchMode(value as LaunchMode)}>
              <SelectTrigger id="launch-mode" className="w-36" data-testid="launch-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAUNCH_MODES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mode === 'scheduled' && (
              <span className="truncate text-xs text-muted-foreground" data-testid="schedule-note">
                {scheduleSummary(process)}
              </span>
            )}
          </div>

          <Label htmlFor="name" className="justify-end text-muted-foreground">
            name
          </Label>
          <Input id="name" placeholder="name of your process" {...field('name')} />

          <Label htmlFor="exe_path" className="justify-end text-muted-foreground">
            exe
          </Label>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              onClick={() => void browse('exe_path')}
              aria-label="browse for an executable"
            >
              <FileSearch />
            </Button>
            <Input
              id="exe_path"
              placeholder="the full path to your executable"
              className="font-mono text-xs"
              {...field('exe_path')}
            />
          </div>

          <Label htmlFor="file_path" className="justify-end text-muted-foreground">
            path / args
          </Label>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              onClick={() => void browse('file_path')}
              aria-label="browse for a file"
            >
              <FileSearch />
            </Button>
            <Input
              id="file_path"
              placeholder="a file to open, or command line arguments"
              className="font-mono text-xs"
              {...field('file_path')}
            />
          </div>

          <Label htmlFor="cwd" className="justify-end text-muted-foreground">
            cwd
          </Label>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              onClick={() => void browse('cwd')}
              aria-label="browse for a working directory"
            >
              <FolderOpen />
            </Button>
            <Input
              id="cwd"
              placeholder="the working directory for your process"
              className="font-mono text-xs"
              {...field('cwd')}
            />
          </div>

          <Label htmlFor="time_delay" className="justify-end text-muted-foreground">
            delay (sec)
          </Label>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Input id="time_delay" className="w-20" inputMode="numeric" {...field('time_delay')} />
              </TooltipTrigger>
              <TooltipContent>seconds to wait before launching this process on startup</TooltipContent>
            </Tooltip>
            <Label htmlFor="priority" className="pl-3 text-muted-foreground">
              priority
            </Label>
            <Select
              value={priorityOf(process)}
              onValueChange={(value) => onPriority(value as Priority)}
            >
              <SelectTrigger id="priority" className="w-32" data-testid="priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Label htmlFor="time_to_init" className="justify-end text-muted-foreground">
            wait (sec)
          </Label>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Input
                  id="time_to_init"
                  className="w-20"
                  inputMode="numeric"
                  {...field('time_to_init')}
                />
              </TooltipTrigger>
              <TooltipContent>seconds to wait after launch before monitoring starts</TooltipContent>
            </Tooltip>
            <Label htmlFor="visibility" className="pl-3 text-muted-foreground">
              visibility
            </Label>
            <Select
              value={visibilityOf(process)}
              onValueChange={(value) => onVisibility(value as Visibility)}
            >
              <SelectTrigger id="visibility" className="w-32" data-testid="visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Label htmlFor="relaunch_attempts" className="justify-end text-muted-foreground">
            attempts
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Input
                id="relaunch_attempts"
                className="w-20"
                inputMode="numeric"
                {...field('relaunch_attempts')}
              />
            </TooltipTrigger>
            <TooltipContent>max relaunch attempts before giving up — 0 is unlimited</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
