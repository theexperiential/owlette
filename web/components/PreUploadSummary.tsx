'use client';

/**
 * PreUploadSummary — confirmation screen shown after hashing and before
 * the operator kicks off the actual upload (roost wave 3.4).
 *
 * Answers four questions in one view: how big / how long / fits-on-disk /
 * fits-in-quota. All decision logic lives in web/lib/preUploadCheck.ts;
 * this component is presentation + action.
 *
 * The "start upload" button is disabled while any blocking check is
 * active — shows the operator exactly what needs to change before the
 * upload can proceed.
 */

import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertTriangle,
  ArrowRight,
  FileCheck,
  Layers,
  Clock,
  XCircle,
} from 'lucide-react';
import type { ManifestFileEntry } from '@/lib/chunking';
import {
  canStartUpload,
  checkQuota,
  checkTargetDisks,
  estimateUploadSeconds,
  formatBytes,
  formatDuration,
  summariseSize,
  type PreUploadCheck,
  type PreUploadTarget,
  type QuotaSnapshot,
} from '@/lib/preUploadCheck';

interface PreUploadSummaryProps {
  entries: ManifestFileEntry[];
  targets: PreUploadTarget[];
  /** Optional — omit for unlimited plans. */
  quota?: QuotaSnapshot;
  /** Set of chunk hashes already present on the server (from /api/chunks/check). */
  alreadyPresent?: Set<string>;
  /** Optional bandwidth estimate in Mbps for the time display. */
  uploadMbps?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PreUploadSummary({
  entries,
  targets,
  quota,
  alreadyPresent,
  uploadMbps,
  onConfirm,
  onCancel,
}: PreUploadSummaryProps) {
  const size = useMemo(
    () => summariseSize(entries, alreadyPresent),
    [entries, alreadyPresent],
  );
  const etaSeconds = useMemo(
    () => estimateUploadSeconds(size.uploadBytes, uploadMbps),
    [size.uploadBytes, uploadMbps],
  );
  const checks = useMemo<PreUploadCheck[]>(() => {
    const out: PreUploadCheck[] = [];
    out.push(...checkTargetDisks(targets, size.totalBytes));
    const q = checkQuota(size.uploadBytes, quota);
    if (q) out.push(q);
    return out;
  }, [targets, quota, size.totalBytes, size.uploadBytes]);

  const canStart = canStartUpload(checks);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">ready to roost?</h3>
          <p className="text-xs text-muted-foreground">
            review the numbers and confirm to start the upload. nothing is
            sent until you click start.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <StatTile
            icon={<FileCheck className="h-4 w-4" />}
            label="files"
            value={size.fileCount.toLocaleString()}
          />
          <StatTile
            icon={<Layers className="h-4 w-4" />}
            label="total size"
            value={formatBytes(size.totalBytes)}
            sub={
              size.uploadBytes < size.totalBytes
                ? `${formatBytes(size.uploadBytes)} after dedup (${Math.round(size.dedupRatio * 100)}% saved)`
                : undefined
            }
          />
          <StatTile
            icon={<Clock className="h-4 w-4" />}
            label="est. upload time"
            value={formatDuration(etaSeconds)}
            sub={uploadMbps ? `at ${uploadMbps} Mbps` : 'at 50 Mbps (default)'}
          />
          <StatTile
            icon={<ArrowRight className="h-4 w-4" />}
            label="target machines"
            value={targets.length.toLocaleString()}
          />
        </div>

        {checks.length > 0 && (
          <div className="space-y-2">
            {checks.map((c, i) => (
              <Alert
                key={i}
                variant={c.severity === 'error' ? 'destructive' : 'default'}
              >
                {c.severity === 'error' ? (
                  <XCircle className="h-4 w-4" />
                ) : (
                  <AlertTriangle className="h-4 w-4" />
                )}
                <AlertDescription>{c.message}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={!canStart}>
            start upload
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default PreUploadSummary;

/* --------------------------------------------------------------------- */
/*  Internal                                                             */
/* --------------------------------------------------------------------- */

interface StatTileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}

function StatTile({ icon, label, value, sub }: StatTileProps) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-sm font-medium">{value}</div>
      {sub && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}
