'use client';

import React, { useState } from 'react';
import { Brain } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { Machine } from '@/hooks/useFirestore';

interface CortexPowerToggleProps {
  siteId: string;
  machine: Machine;
}

export function CortexPowerToggle({ siteId, machine }: CortexPowerToggleProps) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const enabled = machine.cortexEnabled !== false;

  const handleConfirm = async () => {
    if (!db || busy) return;
    setBusy(true);
    try {
      const machineRef = doc(db, 'sites', siteId, 'machines', machine.machineId);
      await updateDoc(machineRef, { cortexEnabled: !enabled });
    } catch (err) {
      console.error('Failed to toggle cortexEnabled:', err);
    } finally {
      setBusy(false);
    }
  };

  const label = enabled ? 'cortex active' : 'cortex inactive';
  const tooltip = enabled
    ? 'cortex active — click to disable tool calls on this machine'
    : 'cortex inactive — click to re-enable tool calls on this machine';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            aria-label={tooltip}
            aria-pressed={!enabled}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              enabled
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                : 'border-orange-500/50 bg-orange-500/15 text-orange-400 hover:bg-orange-500/25'
            }`}
          >
            <Brain className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={enabled ? 'disable cortex on this machine?' : 'enable cortex on this machine?'}
        description={
          enabled
            ? `cortex tool calls will be blocked on "${machine.machineId}" until re-enabled. the agent will stay online for monitoring — only LLM-initiated actions (manual and autonomous) are paused.`
            : `cortex tool calls will resume on "${machine.machineId}". both manual chat and autonomous investigations will be able to execute tools on this machine again.`
        }
        confirmText={enabled ? 'disable cortex' : 'enable cortex'}
        cancelText="cancel"
        onConfirm={handleConfirm}
        variant={enabled ? 'destructive' : 'default'}
      />
    </>
  );
}
