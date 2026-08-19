import { FileSearch } from 'lucide-react'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormError } from '@/components/ui/form-error'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProcessEntryDraft } from '@/lib/dropClassifier'
import { describeKind, type DropCard } from '@/lib/dropQueue'
import { pickExecutable } from '@/lib/pickers'

interface DropConfirmProps {
  /** The card at the head of the queue, or null when there is nothing to review. */
  card: DropCard | null
  /** Cards still waiting, this one included. */
  remaining: number
  /** Why `add process` is refused, from `cardBlockedReason`. */
  blockedReason: string | null
  onChange: (patch: Partial<ProcessEntryDraft>) => void
  onConfirm: () => void
  onSkip: () => void
}

/**
 * What a dropped file is about to become.
 *
 * Shown rather than written, because every field on it is a *derivation*: the
 * name came from the file name, the executable from whichever TouchDesigner or
 * python install this machine happens to have, the working directory from the
 * folder the file sits in. Each one is usually right and occasionally not, and
 * an operator who watches an entry appear fully-formed has no idea which of
 * them to check. So the card is the checkpoint — read it, fix the name, add the
 * interpreter it could not find, and only then does anything reach the disk.
 *
 * Editable is exactly the set that can be wrong in a way the operator can fix
 * here: the name always, plus whatever the classifier admits it could not
 * derive. The rest is shown as evidence and edited afterwards in the detail
 * panel, which is a form built for it.
 */
export function DropConfirm({
  card,
  remaining,
  blockedReason,
  onChange,
  onConfirm,
  onSkip,
}: DropConfirmProps) {
  const needsExe = card?.needsInput.includes('exe_path') ?? false

  const browse = useCallback(async () => {
    try {
      const picked = await pickExecutable(card?.entry.exe_path)
      if (picked !== null) onChange({ exe_path: picked })
    } catch (cause) {
      toast.error('could not open the file picker', {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }, [card?.entry.exe_path, onChange])

  return (
    <Dialog open={card !== null} onOpenChange={(open) => !open && onSkip()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false} data-testid="drop-confirm">
        <DialogHeader>
          <DialogTitle>add process</DialogTitle>
          <DialogDescription>
            {card ? `owlette read this as ${describeKind(card.kind)}.` : ''}
            {remaining > 1 && (
              <span data-testid="drop-remaining">
                {` ${remaining - 1} more ${remaining === 2 ? 'file is' : 'files are'} waiting.`}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {card && (
          <div className="space-y-4">
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
              <Label htmlFor="drop-name" className="justify-end text-muted-foreground">
                name
              </Label>
              <Input
                id="drop-name"
                value={card.entry.name}
                autoFocus
                onChange={(event) => onChange({ name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || blockedReason) return
                  event.preventDefault()
                  onConfirm()
                }}
              />

              {needsExe ? (
                <>
                  <Label htmlFor="drop-exe" className="justify-end text-muted-foreground">
                    exe
                  </Label>
                  <div className="flex min-w-0 items-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => void browse()}
                      aria-label="browse for an executable"
                    >
                      <FileSearch />
                    </Button>
                    <Input
                      id="drop-exe"
                      value={card.entry.exe_path}
                      placeholder="the program that should open this file"
                      className="font-mono text-xs"
                      onChange={(event) => onChange({ exe_path: event.target.value })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <DerivedLabel>exe</DerivedLabel>
                  <Derived value={card.entry.exe_path} />
                </>
              )}

              {card.entry.file_path && (
                <>
                  <DerivedLabel>path / args</DerivedLabel>
                  <Derived value={card.entry.file_path} />
                </>
              )}

              <DerivedLabel>cwd</DerivedLabel>
              <Derived value={card.entry.cwd} />
            </div>

            {card.warnings.map((warning) => (
              <InlineNotice key={warning} data-testid="drop-warning">
                <p className="text-sm leading-snug">{warning}</p>
              </InlineNotice>
            ))}

            <FormError message={blockedReason} />

            <p className="text-xs text-muted-foreground">
              it is added with its launch mode off — set that once you have checked it.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onSkip}>
            skip
          </Button>
          <Button onClick={onConfirm} disabled={blockedReason !== null}>
            add process
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A field the classifier worked out.
 *
 * Read-only, so it is labelled with a span rather than a `<label>`: a label
 * with nothing to focus is a promise to assistive tech that this app cannot
 * keep. These are edited in the detail panel once the entry exists.
 */
function Derived({ value }: { value: string }) {
  return (
    <p className="truncate font-mono text-xs text-muted-foreground" title={value}>
      {value}
    </p>
  )
}

function DerivedLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-right text-sm text-muted-foreground">{children}</span>
}
