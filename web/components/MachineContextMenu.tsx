'use client';

import { useState } from 'react';
import { MoreVertical, Trash2, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

interface MachineContextMenuProps {
  machineId: string;
  machineName: string;
  siteId: string;
  isOnline: boolean;
  onRemoveMachine: () => void;
}

export function MachineContextMenu({
  machineId,
  machineName,
  siteId,
  isOnline,
  onRemoveMachine,
}: MachineContextMenuProps) {
  const [showRevokeDialog, setShowRevokeDialog] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const handleRevokeToken = async () => {
    setIsRevoking(true);
    try {
      const response = await fetch('/api/admin/tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, machineId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke token');
      }

      toast.success(`Token revoked for ${machineName}`, {
        description: 'The machine will need to be re-registered to reconnect.',
      });
    } catch (error: any) {
      toast.error('Failed to revoke token', {
        description: error.message,
      });
    } finally {
      setIsRevoking(false);
      setShowRevokeDialog(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-white hover:bg-accent cursor-pointer"
            onClick={(e) => {
              // Prevent row click event from firing
              e.stopPropagation();
            }}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-secondary w-48">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setShowRevokeDialog(true);
            }}
            className="text-amber-400 focus:bg-amber-950/30 focus:text-amber-300 cursor-pointer"
          >
            <KeyRound className="mr-2 h-4 w-4" />
            Revoke Token
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-accent" />
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onRemoveMachine();
            }}
            className="text-red-400 focus:bg-red-950/30 focus:text-red-300 cursor-pointer"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remove Machine
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showRevokeDialog} onOpenChange={setShowRevokeDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>Revoke Token for {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will immediately invalidate the machine&apos;s authentication token.
              The agent will disconnect and cannot reconnect until re-registered with a new registration code.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRevokeDialog(false)}
              className="bg-secondary border-border hover:bg-accent"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRevokeToken}
              disabled={isRevoking}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isRevoking ? 'Revoking...' : 'Revoke Token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
