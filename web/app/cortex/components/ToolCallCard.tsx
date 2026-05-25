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
  /**
   * Tier-3 approval (human-in-the-loop). `requested` shows approve/deny
   * controls; `denied` shows the declined state. Absent for tier-1/2 tools
   * and for already-executed tier-3 calls.
   */
  approvalState?: 'requested' | 'denied';
  /** Where the tool will run, e.g. a machine name or "all machines". */
  approvalTargetLabel?: string;
  onApprove?: () => void;
  onDeny?: () => void;
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
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const toolDef = getToolByName(toolName);

  const hasError = result != null && typeof result === 'object' && !!(result as Record<string, unknown>).error;
  const tierLabel = toolDef ? `Tier ${toolDef.tier}` : '';
  const awaitingApproval = approvalState === 'requested';
  const denied = approvalState === 'denied';

  // Inline preview for screenshot captures: prefer the uploaded Firebase URL,
  // fall back to inline base64 JPEG if the upload failed but the capture succeeded.
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
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
      >
        {statusIcon}

        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />

        <span className="font-mono text-xs text-foreground">{toolName}</span>

        {tierLabel && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground">
            {tierLabel}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
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

      {/* Approval banner — privileged tier-3 action needs explicit go-ahead.
          The payload stays collapsed (expand the card header to inspect the
          input) so it isn't duplicated here and under the expanded view. */}
      {awaitingApproval && (
        <div className="border-t border-amber-500/30 px-3 py-2.5 space-y-2.5">
          <p className="text-xs text-foreground">
            cortex wants to run the privileged <span className="font-mono">{toolName}</span> tool
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

      {/* Inline screenshot preview (always visible when available) */}
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

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {/* Arguments */}
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

          {/* Result */}
          {result != null && (() => {
            // Strip the inline base64 screenshot blob from the JSON dump —
            // it's already rendered visually above and is too large to read.
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
