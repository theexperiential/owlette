'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface RemoveMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  machineName: string;
  isOnline: boolean;
  hasActiveDeployments: boolean;
  isRemoving: boolean;
  onConfirmRemove: () => void;
}

export function RemoveMachineDialog({
  open,
  onOpenChange,
  machineId,
  machineName,
  isOnline,
  hasActiveDeployments,
  isRemoving,
  onConfirmRemove,
}: RemoveMachineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            Remove Machine from Site
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            This action will permanently remove <span className="font-mono text-white">{machineName}</span> from this site.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Active Deployment Warning (Blocks Removal) */}
          {hasActiveDeployments && (
            <Alert className="border-red-800 bg-red-950/30">
              <AlertTriangle className="h-4 w-4 text-red-400" />
              <AlertDescription className="text-red-300 text-sm ml-2">
                This machine has active deployments in progress. Please wait for them to complete before removing the machine.
              </AlertDescription>
            </Alert>
          )}

          {/* Online Machine Warning */}
          {isOnline && !hasActiveDeployments && (
            <Alert className="border-yellow-800 bg-yellow-950/30">
              <AlertTriangle className="h-4 w-4 text-yellow-400" />
              <AlertDescription className="text-yellow-300 text-sm ml-2">
                This machine is currently online. The Owlette agent will detect the removal and stop syncing automatically.
              </AlertDescription>
            </Alert>
          )}

          {/* Main Warning */}
          <div className="rounded-lg border border-border bg-background p-4 space-y-2">
            <p className="text-sm text-muted-foreground">
              The following will happen:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>All machine data will be deleted from Firestore</li>
              <li>Process configurations will be removed</li>
              <li>Command history will be cleared</li>
              <li>The Owlette agent will be deregistered</li>
            </ul>
          </div>

          {/* Reinstall Notice */}
          <div className="rounded-lg border border-accent-cyan/20 bg-accent-cyan/10 p-4">
            <p className="text-sm text-accent-cyan">
              To add this machine back to a site, you will need to re-run the Owlette installer and configure it with a Site ID.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isRemoving}
            className="border-border bg-secondary text-white hover:bg-muted hover:text-white cursor-pointer disabled:cursor-not-allowed"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirmRemove}
            disabled={hasActiveDeployments || isRemoving}
            className="bg-red-600 hover:bg-red-700 text-white cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRemoving ? 'Removing...' : 'Remove Machine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
