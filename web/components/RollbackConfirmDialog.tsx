'use client';

/**
 * RollbackConfirmDialog — confirm flipping the manifest pointer to a
 * prior version, showing exactly what changes (roost wave 3.7).
 *
 * Rolling back a roost distribution is an atomic compare-and-swap on the
 * folder doc's `currentManifestId`. From the operator's perspective, the
 * dangerous part isn't the API call — it's not knowing what they're
 * about to push to the fleet. This dialog answers three questions:
 *
 *   1. What files differ between now and the target?
 *   2. How much data is being moved (net delta)?
 *   3. Do we ease it in via canary, or flip everything at once?
 *
 * Decision logic lives in `web/lib/manifestDiff.ts`. This component is
 * presentation + the HTTP POST to `/api/roosts/{roostId}/rollback`.
 * Until wave 2a.6 wires the route, the endpoint returns 501 and the
 * dialog surfaces that to the operator verbatim — better than a
 * misleading "done" toast.
 */

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FilePlus2, FileMinus2, FilePen, History, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ManifestFileEntry } from '@/lib/chunking';
import {
  DEFAULT_ROLLOUT_STRATEGY,
  diffManifests,
  summariseDiff,
  type RolloutStrategy,
} from '@/lib/manifestDiff';
import { formatBytes } from '@/lib/preUploadCheck';

interface RollbackConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  roostId: string;
  /** Current live manifest — what's on the fleet right now. */
  currentManifest: {
    manifestId: string;
    files: ManifestFileEntry[];
  };
  /** Rollback target — which prior version we're flipping to. */
  targetManifest: {
    manifestId: string;
    files: ManifestFileEntry[];
    createdAt?: string; // ISO, for display copy
  };
  /** Called on successful rollback so the parent can refresh its view. */
  onRollbackSuccess?: () => void;
}

export function RollbackConfirmDialog({
  open,
  onOpenChange,
  siteId,
  roostId,
  currentManifest,
  targetManifest,
  onRollbackSuccess,
}: RollbackConfirmDialogProps) {
  const [strategy, setStrategy] = useState<RolloutStrategy>(
    DEFAULT_ROLLOUT_STRATEGY,
  );
  const [rolling, setRolling] = useState(false);

  const diff = useMemo(
    () => diffManifests(currentManifest.files, targetManifest.files),
    [currentManifest.files, targetManifest.files],
  );
  const summary = useMemo(
    () => summariseDiff(currentManifest.files, targetManifest.files, diff),
    [currentManifest.files, targetManifest.files, diff],
  );

  const handleConfirm = async () => {
    setRolling(true);
    try {
      const res = await fetch(`/api/roosts/${roostId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId,
          targetManifestId: targetManifest.manifestId,
          strategy,
        }),
      });

      if (!res.ok) {
        const body = await parseProblemJson(res);
        const detail =
          body?.detail ??
          body?.title ??
          `rollback failed (HTTP ${res.status})`;
        toast.error('rollback failed', { description: detail });
        return;
      }

      toast.success(
        strategy === 'canary'
          ? 'rollback started — canary wave dispatched'
          : 'rollback complete — fleet updated',
      );
      onRollbackSuccess?.();
      onOpenChange(false);
    } catch (err) {
      toast.error('rollback failed', {
        description: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setRolling(false);
    }
  };

  const confirmDisabled = rolling || !summary.hasChanges;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> roll back to manifest{' '}
            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
              {targetManifest.manifestId.slice(0, 12)}
            </code>
          </DialogTitle>
          <DialogDescription>
            flipping the pointer on{' '}
            <code className="text-xs font-mono">{roostId}</code>. nothing
            happens on the fleet until you click confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!summary.hasChanges && (
            <Alert>
              <AlertDescription>
                the target manifest is identical to the current one.
                rollback would be a no-op.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-4 gap-2 text-sm">
            <DiffTile
              icon={<FilePlus2 className="h-4 w-4" />}
              label="added"
              value={summary.added}
              tone="green"
            />
            <DiffTile
              icon={<FileMinus2 className="h-4 w-4" />}
              label="removed"
              value={summary.removed}
              tone="red"
            />
            <DiffTile
              icon={<FilePen className="h-4 w-4" />}
              label="changed"
              value={summary.changed}
              tone="amber"
            />
            <DiffTile label="unchanged" value={summary.unchanged} tone="muted" />
          </div>

          <p className="text-xs text-muted-foreground">
            net size change:{' '}
            <span className="font-mono">
              {summary.netBytesDelta >= 0 ? '+' : ''}
              {formatBytes(Math.abs(summary.netBytesDelta))}
            </span>
          </p>

          {summary.hasChanges && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                changed files (first 50)
              </div>
              <ul className="max-h-48 overflow-y-auto rounded border bg-muted/20 divide-y">
                {[
                  ...diff.added.map((f) => ({ path: f.path, kind: 'added' as const })),
                  ...diff.removed.map((f) => ({ path: f.path, kind: 'removed' as const })),
                  ...diff.changed.map((f) => ({ path: f.path, kind: 'changed' as const })),
                ]
                  .slice(0, 50)
                  .map((entry) => (
                    <li
                      key={`${entry.kind}:${entry.path}`}
                      className="flex items-center gap-2 px-2 py-1 text-xs font-mono"
                    >
                      <KindBadge kind={entry.kind} />
                      <span className="truncate">{entry.path}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">
              rollout strategy
            </legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="rollout-strategy"
                value="canary"
                checked={strategy === 'canary'}
                onChange={() => setStrategy('canary')}
                className="mt-1"
              />
              <div>
                <div className="font-medium">canary (recommended)</div>
                <div className="text-xs text-muted-foreground">
                  roll back to ~10% of the fleet first. if the canary is
                  healthy, the rest follows. aborts automatically if the
                  canary fails.
                </div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="rollout-strategy"
                value="all_at_once"
                checked={strategy === 'all_at_once'}
                onChange={() => setStrategy('all_at_once')}
                className="mt-1"
              />
              <div>
                <div className="font-medium">all at once</div>
                <div className="text-xs text-muted-foreground">
                  roll back every machine simultaneously. use only for
                  critical fixes where the current manifest is actively
                  breaking the show.
                </div>
              </div>
            </label>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={rolling}>
            cancel
          </Button>
          <Button onClick={handleConfirm} disabled={confirmDisabled}>
            {rolling ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                rolling back...
              </>
            ) : strategy === 'canary' ? (
              'start canary rollback'
            ) : (
              'roll back all machines'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RollbackConfirmDialog;

/* --------------------------------------------------------------------- */
/*  Internal                                                             */
/* --------------------------------------------------------------------- */

interface DiffTileProps {
  icon?: React.ReactNode;
  label: string;
  value: number;
  tone: 'green' | 'red' | 'amber' | 'muted';
}

function DiffTile({ icon, label, value, tone }: DiffTileProps) {
  const toneClass = {
    green: 'text-green-500',
    red: 'text-red-500',
    amber: 'text-amber-500',
    muted: 'text-muted-foreground',
  }[tone];
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className={`flex items-center gap-1.5 text-xs ${toneClass}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

function KindBadge({ kind }: { kind: 'added' | 'removed' | 'changed' }) {
  const tone = {
    added: 'text-green-500',
    removed: 'text-red-500',
    changed: 'text-amber-500',
  }[kind];
  const sym = { added: '+', removed: '−', changed: '~' }[kind];
  return (
    <span className={`w-3 text-center font-bold ${tone}`} aria-label={kind}>
      {sym}
    </span>
  );
}

/**
 * Parse an RFC 7807 problem+json body (our roost error envelope). Returns
 * the body if it looks like one, or null if the response isn't JSON.
 */
async function parseProblemJson(
  res: Response,
): Promise<{ type?: string; title?: string; detail?: string } | null> {
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;
    return (await res.json()) as { title?: string; detail?: string };
  } catch {
    return null;
  }
}
