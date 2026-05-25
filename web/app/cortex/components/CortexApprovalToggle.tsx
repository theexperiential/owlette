'use client';

import React, { useState } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useCortexApprovalSetting } from '@/hooks/useCortexApprovalSetting';

interface CortexApprovalToggleProps {
  siteId: string;
}

/**
 * Site-wide admin toggle for the tier-3 approval gate. When ON (default),
 * privileged tool calls pause for in-chat approval and admin single-machine
 * chats route server-side so the gate can fire. Turning it OFF restores local
 * Cortex's lower latency at the cost of the safety gate.
 */
export function CortexApprovalToggle({ siteId }: CortexApprovalToggleProps) {
  const { requireApproval } = useCortexApprovalSetting(siteId);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const setValue = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/cortex-settings`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requireTier3Approval: next }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'Failed to update approval setting');
      }
    } catch (err) {
      console.error('Failed to update cortex approval setting:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleClick = () => {
    // Disabling the gate weakens safety — confirm. Enabling is one click.
    if (requireApproval) setConfirmOpen(true);
    else void setValue(true);
  };

  const label = requireApproval ? 'approval required' : 'approval off';
  const tooltip = requireApproval
    ? 'privileged (tier-3) actions require in-chat approval — click to disable site-wide'
    : 'privileged (tier-3) actions run without approval — click to require approval site-wide';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleClick}
            disabled={busy}
            aria-label={tooltip}
            aria-pressed={requireApproval}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              requireApproval
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                : 'border-border bg-secondary text-muted-foreground hover:bg-accent'
            }`}
          >
            {requireApproval ? (
              <ShieldCheck className="h-3.5 w-3.5" />
            ) : (
              <ShieldOff className="h-3.5 w-3.5" />
            )}
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
        title="disable tier-3 approval site-wide?"
        description={
          'privileged tool calls (run_powershell, execute_script, reboot, etc.) will run immediately without in-chat approval for everyone on this site. admin single-machine chats may also resume using local cortex. only turn this off if the approval prompts are getting in the way.'
        }
        confirmText="disable approval"
        cancelText="cancel"
        onConfirm={() => setValue(false)}
        variant="destructive"
      />
    </>
  );
}
