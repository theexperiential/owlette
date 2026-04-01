/**
 * DeleteProcessDialog Component
 *
 * Confirmation dialog for permanently deleting a process configuration.
 * Shows a warning message and requires explicit confirmation.
 *
 * Used by: ProcessDialog component for delete action
 */

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface DeleteProcessDialogProps {
  open: boolean;
  processName: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteProcessDialog({
  open,
  processName,
  onClose,
  onConfirm,
}: DeleteProcessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader>
          <DialogTitle className="text-foreground">Delete Process</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Are you sure you want to permanently delete &quot;{processName}&quot;? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            className="border-border bg-card text-foreground hover:bg-accent hover:text-foreground cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
          >
            Delete Process
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
