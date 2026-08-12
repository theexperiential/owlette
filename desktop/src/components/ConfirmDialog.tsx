import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * One confirmation, described rather than rendered.
 *
 * Every destructive action in this app asks first — delete, kill, restart —
 * and each one wants its own wording, so the caller hands over the copy and the
 * thing to do rather than a flag.
 */
export interface ConfirmRequest {
  title: string
  description: string
  confirmLabel: string
  /** Paints the confirm button as destructive. Deleting and killing do. */
  destructive?: boolean
  onConfirm: () => void
}

interface ConfirmDialogProps {
  request: ConfirmRequest | null
  onClose: () => void
}

export function ConfirmDialog({ request, onClose }: ConfirmDialogProps) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            cancel
          </Button>
          <Button
            variant={request?.destructive ? 'destructive' : 'default'}
            onClick={() => {
              request?.onConfirm()
              onClose()
            }}
          >
            {request?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
