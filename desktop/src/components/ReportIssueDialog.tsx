import { useCallback, useEffect, useState } from 'react'
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
import { InlineNotice } from '@/components/ui/inline-notice'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { runAgent } from '@/lib/agentCli'

/** Categories the web API accepts (`web/app/api/bug-report/route.ts`). */
const CATEGORIES = [
  { value: 'bug', label: 'something broke' },
  { value: 'feature_request', label: "wouldn't it be nice if..." },
  { value: 'compliment', label: "actually, you're doing great" },
  { value: 'rant', label: 'i just need to vent' },
  { value: 'other', label: "it's complicated" },
] as const

/**
 * Description limit, matching the legacy dialog's counter
 * (`report_issue.ReportIssueApp.MAX_CHARS`). The API allows 50 000, but the rest
 * of that budget is the system info and log tail the agent attaches.
 */
export const MAX_DESCRIPTION = 1000

interface ReportIssueDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Feedback, with the machine's own diagnostics attached.
 *
 * Nothing is gathered here: `configure_site.py --report-issue` collects the
 * system metrics and the last ~100 lines of the service log, and posts them with
 * the agent's own token — the same shape the legacy `report_issue.py` submitted,
 * landing in `bug_reports` with `source: 'agent'`.
 */
export function ReportIssueDialog({ open, onClose }: ReportIssueDialogProps) {
  const [category, setCategory] = useState<string>('bug')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCategory('bug')
    setDescription('')
    setSubmitting(false)
    setError(null)
  }, [open])

  const submit = useCallback(() => {
    const trimmed = description.trim()
    if (!trimmed) {
      setError('please describe the issue before submitting.')
      return
    }

    setSubmitting(true)
    setError(null)

    void runAgent('report-issue', { payload: { category, description: trimmed } })
      .then(() => {
        toast.success('thanks — your feedback was sent', {
          description: 'system info and recent logs went with it.',
        })
        onClose()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setSubmitting(false))
  }, [category, description, onClose])

  const remaining = MAX_DESCRIPTION - description.length

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="report-issue-dialog">
        <DialogHeader>
          <DialogTitle>submit bug report</DialogTitle>
          <DialogDescription>
            help us improve owlette. system info and recent logs are attached automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="feedback-category">category</Label>
          <Select value={category} onValueChange={setCategory} disabled={submitting}>
            <SelectTrigger id="feedback-category" className="w-full" data-testid="report-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="feedback-description">description</Label>
          <Textarea
            id="feedback-description"
            rows={6}
            maxLength={MAX_DESCRIPTION}
            disabled={submitting}
            value={description}
            data-testid="report-description"
            onChange={(event) => setDescription(event.target.value.slice(0, MAX_DESCRIPTION))}
            placeholder="what happened, and what did you expect instead?"
          />
          <p className="text-right text-xs text-muted-foreground" data-testid="report-remaining">
            {remaining} characters left
          </p>
        </div>

        {error && (
          <InlineNotice data-testid="report-error">
            <p className="text-sm">could not send the report</p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            cancel
          </Button>
          <Button onClick={submit} disabled={submitting || description.trim().length === 0}>
            {submitting ? 'sending…' : 'submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
