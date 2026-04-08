'use client';

import { useState } from 'react';
import { MoreVertical, Trash2, KeyRound, RotateCcw, Power, Camera, Settings2, Eye, BellOff, Bell } from 'lucide-react';
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
import { useAuth } from '@/contexts/AuthContext';
import RebootScheduleDialog from '@/components/RebootScheduleDialog';
import type { ScheduleBlock } from '@/hooks/useFirestore';

interface MachineContextMenuProps {
  machineId: string;
  machineName: string;
  siteId: string;
  isOnline: boolean;
  isAdmin?: boolean;
  onRemoveMachine: () => void;
  onReboot?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
  onScreenshot?: () => void;
  onLiveView?: () => void;
  rebootSchedule?: {
    enabled: boolean;
    schedules: ScheduleBlock[];
  };
}

export function MachineContextMenu({
  machineId,
  machineName,
  siteId,
  isOnline,
  isAdmin,
  onRemoveMachine,
  onReboot,
  onShutdown,
  onScreenshot,
  onLiveView,
  rebootSchedule,
}: MachineContextMenuProps) {
  const [showRevokeDialog, setShowRevokeDialog] = useState(false);
  const [showRebootDialog, setShowRebootDialog] = useState(false);
  const [showShutdownDialog, setShowShutdownDialog] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [isSendingCommand, setIsSendingCommand] = useState(false);
  const [showRebootScheduleDialog, setShowRebootScheduleDialog] = useState(false);
  const { userPreferences, updateUserPreferences } = useAuth();
  const isMuted = userPreferences.mutedMachines.includes(machineId);

  const handleToggleMute = async () => {
    const mutedMachines = isMuted
      ? userPreferences.mutedMachines.filter(id => id !== machineId)
      : [...userPreferences.mutedMachines, machineId];
    await updateUserPreferences({ mutedMachines }, { silent: true });
    toast.success(isMuted ? `Alerts unmuted for ${machineName}` : `Alerts muted for ${machineName}`, {
      description: isMuted ? 'You will receive alerts for this machine again.' : 'You will no longer receive email alerts for this machine.',
    });
  };

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

  const handleReboot = async () => {
    if (!onReboot) return;
    setIsSendingCommand(true);
    try {
      await onReboot();
      toast.success(`Reboot command sent to ${machineName}`, {
        description: 'The machine will reboot in 30 seconds. You can cancel during the countdown.',
      });
    } catch (error: any) {
      toast.error('Failed to send reboot command', { description: error.message });
    } finally {
      setIsSendingCommand(false);
      setShowRebootDialog(false);
    }
  };

  const handleShutdown = async () => {
    if (!onShutdown) return;
    setIsSendingCommand(true);
    try {
      await onShutdown();
      toast.success(`Shutdown command sent to ${machineName}`, {
        description: 'The machine will shut down in 30 seconds. You can cancel during the countdown.',
      });
    } catch (error: any) {
      toast.error('Failed to send shutdown command', { description: error.message });
    } finally {
      setIsSendingCommand(false);
      setShowShutdownDialog(false);
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
          {isOnline && (
            <>
              <div className="flex items-center justify-between px-2 py-1.5 text-sm text-cyan-400 rounded-sm hover:bg-cyan-950/30 hover:text-cyan-300">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRebootDialog(true);
                  }}
                  className="flex-1 p-0 text-cyan-400 focus:bg-transparent focus:text-cyan-300 cursor-pointer"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  reboot machine
                </DropdownMenuItem>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRebootScheduleDialog(true);
                  }}
                  className="ml-2 p-0.5 rounded hover:bg-cyan-950/50 transition-colors cursor-pointer"
                  title="schedule reboots"
                >
                  <Settings2 className="h-3.5 w-3.5 text-muted-foreground hover:text-cyan-300 transition-colors" />
                </button>
              </div>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setShowShutdownDialog(true);
                }}
                className="text-purple-400 focus:bg-purple-950/30 focus:text-purple-300 cursor-pointer"
              >
                <Power className="mr-2 h-4 w-4" />
                shutdown machine
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onScreenshot?.();
                }}
                className="text-sky-400 focus:bg-sky-950/30 focus:text-sky-300 cursor-pointer"
              >
                <Camera className="mr-2 h-4 w-4" />
                screenshot
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onLiveView?.();
                }}
                className="text-emerald-400 focus:bg-emerald-950/30 focus:text-emerald-300 cursor-pointer"
              >
                <Eye className="mr-2 h-4 w-4" />
                live view
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-accent" />
            </>
          )}
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              handleToggleMute();
            }}
            className="text-muted-foreground focus:bg-accent focus:text-white cursor-pointer"
          >
            {isMuted ? <Bell className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}
            {isMuted ? 'unmute alerts' : 'mute alerts'}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-accent" />
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setShowRevokeDialog(true);
            }}
            className="text-amber-400 focus:bg-amber-950/30 focus:text-amber-300 cursor-pointer"
          >
            <KeyRound className="mr-2 h-4 w-4" />
            revoke token
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
            remove machine
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Revoke Token Dialog */}
      <Dialog open={showRevokeDialog} onOpenChange={setShowRevokeDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>revoke token for {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              this will immediately invalidate the machine&apos;s authentication token.
              the agent will disconnect and cannot reconnect until re-registered with a new registration code.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRevokeDialog(false)}
              className="bg-secondary border-border hover:bg-accent"
            >
              cancel
            </Button>
            <Button
              onClick={handleRevokeToken}
              disabled={isRevoking}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isRevoking ? 'revoking...' : 'revoke token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reboot Confirmation Dialog */}
      <Dialog open={showRebootDialog} onOpenChange={setShowRebootDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>reboot {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              this will restart the machine in 30 seconds. all running processes will be interrupted.
              you can cancel during the countdown.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRebootDialog(false)}
              className="bg-secondary border-border hover:bg-accent"
            >
              cancel
            </Button>
            <Button
              onClick={handleReboot}
              disabled={isSendingCommand}
              className="bg-red-600 hover:bg-red-700"
            >
              {isSendingCommand ? 'sending...' : 'reboot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shutdown Confirmation Dialog */}
      <Dialog open={showShutdownDialog} onOpenChange={setShowShutdownDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>shutdown {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              this will shut down the machine in 30 seconds. the machine will not automatically restart.
              you can cancel during the countdown.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowShutdownDialog(false)}
              className="bg-secondary border-border hover:bg-accent"
            >
              cancel
            </Button>
            <Button
              onClick={handleShutdown}
              disabled={isSendingCommand}
              className="bg-red-600 hover:bg-red-700"
            >
              {isSendingCommand ? 'sending...' : 'shutdown'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reboot Schedule Dialog */}
      <RebootScheduleDialog
        siteId={siteId}
        machineId={machineId}
        machineName={machineName}
        open={showRebootScheduleDialog}
        onOpenChange={setShowRebootScheduleDialog}
        currentSchedule={rebootSchedule}
      />
    </>
  );
}
