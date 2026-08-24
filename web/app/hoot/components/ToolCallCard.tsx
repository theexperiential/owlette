'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle2, AlertCircle, Loader2, ShieldAlert, Ban, Check } from 'lucide-react';
import { getToolByName } from '@/lib/mcp-tools';
import { Button } from '@/components/ui/button';
import { CopyButton } from './CopyButton';

interface ToolCallCardProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isLoading?: boolean;
  /** Tier-3 human-in-the-loop gate; absent for tier-1/2 and executed calls. */
  approvalState?: 'requested' | 'denied';
  /** Where the tool will run, e.g. a machine name or "all machines". */
  approvalTargetLabel?: string;
  onApprove?: () => void;
  onDeny?: () => void;
  /** Only set while executing with >=1 agent command dispatched (cancels the
   *  whole fan-out); server-side and undispatched calls get no cancel. */
  onCancel?: () => void;
  /** Cancel request in flight — disables the button. */
  cancelPending?: boolean;
}

export function ToolCallCard({
  toolName,
  args,
  result,
  isLoading,
  approvalState,
  approvalTargetLabel,
  onApprove,
  onDeny,
  onCancel,
  cancelPending,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const toolDef = getToolByName(toolName);

  const hasError = result != null && typeof result === 'object' && !!(result as Record<string, unknown>).error;
  const tierLabel = toolDef ? `Tier ${toolDef.tier}` : '';
  const awaitingApproval = approvalState === 'requested';
  const denied = approvalState === 'denied';

  // Prefer the uploaded Firebase URL; fall back to inline base64 if upload failed.
  let screenshotSrc: string | null = null;
  if (toolName === 'capture_screenshot' && result != null && typeof result === 'object' && !hasError) {
    const r = result as Record<string, unknown>;
    if (typeof r.url === 'string' && r.url) {
      screenshotSrc = r.url;
    } else if (typeof r.base64 === 'string' && r.base64) {
      screenshotSrc = `data:image/jpeg;base64,${r.base64}`;
    }
  }

  const statusIcon = awaitingApproval ? (
    <ShieldAlert className="h-4 w-4 text-amber-400" />
  ) : isLoading ? (
    <Loader2 className="h-4 w-4 text-accent-cyan animate-spin" />
  ) : denied ? (
    <Ban className="h-4 w-4 text-muted-foreground" />
  ) : hasError ? (
    <AlertCircle className="h-4 w-4 text-red-400" />
  ) : (
    <CheckCircle2 className="h-4 w-4 text-green-400" />
  );

  return (
    <div
      className={`my-2 rounded-lg border overflow-hidden ${
        awaitingApproval ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-secondary/50'
      }`}
    >
      {/* Cancel is a sibling of the expand toggle, never nested inside it —
          nested interactive controls are an axe violation. */}
      <div className="flex items-stretch">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
        >
          {statusIcon}

          <Wrench className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />

          <span className="font-mono text-xs text-foreground truncate">{toolName}</span>

          {tierLabel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground flex-shrink-0">
              {tierLabel}
            </span>
          )}

          <span className="ml-auto flex items-center gap-1 text-muted-foreground flex-shrink-0">
            {awaitingApproval && <span className="text-xs text-amber-400">awaiting approval</span>}
            {denied && <span className="text-xs">denied</span>}
            {isLoading && !awaitingApproval && <span className="text-xs">executing...</span>}
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        </button>

        {isLoading && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelPending}
            title="cancel this tool call"
            className="flex-shrink-0 flex items-center gap-1 px-2.5 border-l border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Ban className="h-3.5 w-3.5" />
            )}
            cancel
          </button>
        )}
      </div>

      {/* Approval banner. Payload stays collapsed so it isn't duplicated here
          and in the expanded view. */}
      {awaitingApproval && (
        <div className="border-t border-amber-500/30 px-3 py-2.5 space-y-2.5">
          <p className="text-xs text-foreground">
            hoot wants to run the privileged <span className="font-mono">{toolName}</span> tool
            {approvalTargetLabel ? <> on <span className="font-medium">{approvalTargetLabel}</span></> : null}. approve to continue, or expand to inspect the input.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={submitting || !onApprove}
              onClick={() => { setSubmitting(true); onApprove?.(); }}
              className="h-8"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={submitting || !onDeny}
              onClick={() => { setSubmitting(true); onDeny?.(); }}
              className="h-8"
            >
              <Ban className="h-3.5 w-3.5" />
              deny
            </Button>
          </div>
        </div>
      )}

      {screenshotSrc && (
        <a
          href={screenshotSrc}
          target="_blank"
          rel="noopener noreferrer"
          className="block border-t border-border bg-background"
          onClick={(e) => e.stopPropagation()}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={screenshotSrc}
            alt="Screenshot"
            className="w-full max-h-[480px] object-contain"
          />
        </a>
      )}

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {Object.keys(args).length > 0 && (
            <div>
              <div className="flex items-center">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  input
                </span>
                <CopyButton value={JSON.stringify(args, null, 2)} className="ml-2" />
              </div>
              <pre className="mt-1 text-xs font-mono text-foreground bg-background rounded p-2 overflow-x-auto max-h-32">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {result != null && (() => {
            // Strip the base64 blob — already rendered above, unreadable as JSON.
            let displayResult: unknown = result;
            if (screenshotSrc && typeof result === 'object') {
              const { base64: _b64, ...rest } = result as Record<string, unknown>;
              void _b64;
              displayResult = rest;
            }
            const resultStr = typeof displayResult === 'string'
              ? displayResult
              : JSON.stringify(displayResult, null, 2);
            return (
              <div>
                <div className="flex items-center">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    output
                  </span>
                  <CopyButton value={resultStr} className="ml-2" />
                </div>
                <pre
                  className={`mt-1 text-xs font-mono rounded p-2 overflow-x-auto max-h-64 ${
                    hasError
                      ? 'text-red-300 bg-red-950/30'
                      : 'text-foreground bg-background'
                  }`}
                >
                  {resultStr}
                </pre>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
