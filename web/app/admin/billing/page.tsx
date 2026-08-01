'use client';

/**
 * /admin/billing — billing ops dashboard (billing-system task 4.2).
 *
 * Population, revenue, conversion, and storage pressure in one screen, all of
 * it from a single `GET /api/admin/billing/overview` call. No client Firestore
 * and no `firestore.rules` change: `customers/*` and the per-site roost quotas
 * are unreadable from the browser by design, and the aggregation runs
 * server-side with the admin SDK.
 *
 * The MRR figure is a **projection at list price**, not billed revenue — the
 * tile says so, and the coverage note under it reports how many subscribed
 * accounts actually had a usage mirror to project from.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertTriangle, HardDrive, RefreshCw, TrendingUp, Users } from 'lucide-react';
import { formatUsd } from '@/lib/billing/pricing';
import { formatBytes } from '@/lib/preUploadCheck';
import type { BillingState } from '@/lib/types/customer';
import type {
  AdminBillingOverviewResponse,
  AdminBillingStorageRow,
} from '@/lib/types/billingAdmin';

const STATE_ORDER: readonly BillingState[] = ['trialing', 'active', 'expired', 'canceled'];

const STATE_TONE: Record<BillingState, string> = {
  trialing: 'text-accent-warm',
  active: 'text-primary',
  expired: 'text-destructive',
  canceled: 'text-muted-foreground',
};

/** A percentage with one decimal, or an em dash when the fraction is unknown. */
function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}

function StatTile({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-3xl font-bold text-foreground mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-2">{hint}</p>
          </div>
          <div className="text-muted-foreground shrink-0">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function StorageTable({
  rows,
  emptyCopy,
}: {
  rows: AdminBillingStorageRow[];
  emptyCopy: string;
}) {
  if (rows.length === 0) {
    return <div className="text-center py-6 text-muted-foreground text-sm">{emptyCopy}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-card">
            <TableHead className="text-foreground">account</TableHead>
            <TableHead className="text-foreground">sites</TableHead>
            <TableHead className="text-foreground">used</TableHead>
            <TableHead className="text-foreground">included</TableHead>
            <TableHead className="text-foreground">of allowance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.uid}
              data-testid={`storage-row-${row.uid}`}
              className="border-border hover:bg-muted/40"
            >
              <TableCell className="text-foreground">
                <div className="font-medium">{row.email ?? row.uid}</div>
                <div className="text-xs text-muted-foreground">{row.uid}</div>
              </TableCell>
              <TableCell className="text-muted-foreground">{row.siteCount}</TableCell>
              <TableCell className="text-foreground">{formatBytes(row.usedBytes)}</TableCell>
              <TableCell className="text-muted-foreground">
                {row.includedBytes > 0 ? formatBytes(row.includedBytes) : '—'}
              </TableCell>
              <TableCell>
                <span className="text-foreground">{formatPercent(row.usedFraction)}</span>
                {row.overageBytes > 0 && (
                  <Badge
                    variant="outline"
                    className="ml-2 bg-destructive/15 text-destructive border-destructive/30"
                  >
                    over by {formatBytes(row.overageBytes)}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AdminBillingPage() {
  const [overview, setOverview] = useState<AdminBillingOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/billing/overview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail || data?.title || 'failed to load billing overview');
      }
      setOverview(data as AdminBillingOverviewResponse);
      setLoadError(null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setOverview(null);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">billing</h1>
            <p className="text-muted-foreground">
              fleet-wide billing health — population, projected revenue, conversion, and storage
              pressure.
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void loadOverview()}
            disabled={loading}
            aria-label="refresh overview"
            className="border-border text-foreground hover:bg-accent! hover:text-foreground!"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {loading && !overview ? (
          <div className="text-center py-16 text-muted-foreground">loading billing overview...</div>
        ) : loadError ? (
          <div className="text-center py-16 text-muted-foreground">
            <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-destructive opacity-80" />
            <p>could not load the billing overview</p>
            <p className="text-sm mt-1">{loadError}</p>
          </div>
        ) : overview ? (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatTile
                label="accounts"
                value={String(overview.customers.total)}
                hint={`${overview.customers.comped} comped`}
                icon={<Users className="h-5 w-5" />}
              />
              <StatTile
                label="mrr projection"
                value={formatUsd(overview.mrr.projectedUsd)}
                hint={
                  overview.mrr.withUsage < overview.mrr.accounts
                    ? `projection at list price — usage data for ${overview.mrr.withUsage} of ${overview.mrr.accounts} subscribed accounts, so this is a floor`
                    : `projection at list price across ${overview.mrr.accounts} subscribed accounts`
                }
                icon={<TrendingUp className="h-5 w-5" />}
              />
              <StatTile
                label="trial conversion"
                value={formatPercent(overview.conversion.rate)}
                hint={`${overview.conversion.converted} converted · ${overview.conversion.expired} expired`}
                icon={<TrendingUp className="h-5 w-5" />}
              />
              <StatTile
                label="approaching overage"
                value={String(overview.storage.approachingOverage.length)}
                hint={`at or past ${formatPercent(overview.storage.alertThreshold)} of the included allowance`}
                icon={<HardDrive className="h-5 w-5" />}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-foreground text-base">by billing state</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-2">
                    {STATE_ORDER.map((state) => (
                      <div key={state} className="flex items-center justify-between">
                        <dt className={`text-sm ${STATE_TONE[state]}`}>{state}</dt>
                        <dd
                          data-testid={`state-count-${state}`}
                          className="text-foreground font-medium tabular-nums"
                        >
                          {overview.customers.byState[state]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-foreground text-base">by tier</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-2">
                    {(['core', 'pro', 'none'] as const).map((tier) => (
                      <div key={tier} className="flex items-center justify-between">
                        <dt className="text-sm text-muted-foreground">
                          {tier === 'none' ? 'no tier yet' : tier}
                        </dt>
                        <dd
                          data-testid={`tier-count-${tier}`}
                          className="text-foreground font-medium tabular-nums"
                        >
                          {overview.customers.byTier[tier]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </div>

            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground text-base">
                  accounts approaching storage overage
                </CardTitle>
              </CardHeader>
              <CardContent>
                <StorageTable
                  rows={overview.storage.approachingOverage}
                  emptyCopy="no account is near its included storage."
                />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground text-base">top accounts by storage</CardTitle>
              </CardHeader>
              <CardContent>
                <StorageTable
                  rows={overview.storage.topAccounts}
                  emptyCopy="no roost storage is in use yet."
                />
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
              generated {new Date(overview.generatedAt).toLocaleString()}
              {overview.mrr.latestPeriod ? ` · usage period ${overview.mrr.latestPeriod}` : ''}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
