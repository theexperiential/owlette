'use client';

/**
 * RoostContentsRow — expandable "contents" row inside an expanded roost
 * panel. Collapsed: "N files · X MB" with a disclosure chevron. Expanded:
 * lazy-fetches the version JSON from R2 and shows path + size for every
 * file, scrollable.
 *
 * Why separate component:
 *   - Keeps the network/hook lifecycle scoped to the row. Collapsed rows
 *     never mount the hook, so listing 20 roosts doesn't fan out into 20
 *     version fetches until the user explicitly expands.
 *   - `useRoostManifestFiles` has a module-level cache keyed by versionId,
 *     so an expand → collapse → expand cycle hits the cache with no
 *     loading flicker or re-fetch.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { formatBytes } from '@/lib/preUploadCheck';
import { useRoostManifestFiles } from '@/hooks/useRoostManifestFiles';

interface RoostContentsRowProps {
  siteId: string;
  roostId: string;
  versionId: string | null;
  totalFiles?: number;
  totalSize?: number;
}

const PREVIEW_CAP = 500;

export function RoostContentsRow({
  siteId,
  roostId,
  versionId,
  totalFiles,
  totalSize,
}: RoostContentsRowProps) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = !!versionId && (totalFiles ?? 0) > 0;
  const { files, loading, error } = useRoostManifestFiles(
    siteId,
    roostId,
    versionId,
    expanded && canExpand,
  );

  if (totalFiles === undefined && totalSize === undefined) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <button
          type="button"
          onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
          disabled={!canExpand}
          aria-expanded={expanded}
          aria-label={expanded ? 'hide file list' : 'show file list'}
          className={`flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors ${
            canExpand
              ? 'hover:text-foreground cursor-pointer'
              : 'cursor-default'
          }`}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>contents</span>
        </button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalFiles !== undefined && (
            <>
              {totalFiles.toLocaleString()} file{totalFiles === 1 ? '' : 's'}
            </>
          )}
          {totalFiles !== undefined && totalSize !== undefined && ' · '}
          {totalSize !== undefined && formatBytes(totalSize)}
        </span>
      </div>

      {expanded && canExpand && (
        <div className="rounded border border-border/40 bg-background/50">
          {loading && files.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading file list…
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-xs text-red-400/80">
              couldn&apos;t load file list — {error}
            </div>
          ) : files.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">
              version has no files
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto px-3 py-2 font-mono text-[11px] text-muted-foreground">
              <ul className="space-y-0.5">
                {files.slice(0, PREVIEW_CAP).map((f, idx) => (
                  <li
                    key={`${f.path}-${idx}`}
                    className="flex items-baseline gap-2 min-w-0"
                  >
                    <span className="truncate text-foreground/90 min-w-0 flex-1 select-text">
                      {f.path}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {formatBytes(f.size)}
                    </span>
                  </li>
                ))}
                {files.length > PREVIEW_CAP && (
                  <li className="pt-1 text-muted-foreground italic">
                    … and {(files.length - PREVIEW_CAP).toLocaleString()} more file
                    {files.length - PREVIEW_CAP === 1 ? '' : 's'}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
