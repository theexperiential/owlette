'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { getToolByName } from '@/lib/mcp-tools';

interface ToolCallCardProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isLoading?: boolean;
}

export function ToolCallCard({ toolName, args, result, isLoading }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const toolDef = getToolByName(toolName);

  const hasError = result != null && typeof result === 'object' && 'error' in (result as Record<string, unknown>);
  const tierLabel = toolDef ? `Tier ${toolDef.tier}` : '';

  return (
    <div className="my-2 rounded-lg border border-border bg-secondary/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 text-accent-cyan animate-spin" />
        ) : hasError ? (
          <AlertCircle className="h-4 w-4 text-red-400" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-green-400" />
        )}

        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />

        <span className="font-mono text-xs text-foreground">{toolName}</span>

        {tierLabel && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground">
            {tierLabel}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {isLoading && <span className="text-xs">executing...</span>}
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {/* Arguments */}
          {Object.keys(args).length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                arguments
              </span>
              <pre className="mt-1 text-xs font-mono text-foreground bg-background rounded p-2 overflow-x-auto max-h-32">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {result != null && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                result
              </span>
              <pre
                className={`mt-1 text-xs font-mono rounded p-2 overflow-x-auto max-h-64 ${
                  hasError
                    ? 'text-red-300 bg-red-950/30'
                    : 'text-foreground bg-background'
                }`}
              >
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
