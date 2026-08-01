'use client';

/**
 * /admin/customers — billing account management (billing-system task 4.1).
 *
 * The superadmin surface for the three manual billing interventions: extend a
 * trial, comp a tier, force an expiry. Everything it renders comes from
 * `GET /api/admin/billing/customers` and every mutation goes through
 * `POST /api/admin/billing/customers/{uid}` — there is no client Firestore
 * here, because `customers/*` is not client-readable and must not become so
 * for an admin table.
 *
 * Superadmin gating is the layout's (`RequireSuperadmin`) for the chrome and
 * the routes' for the data; neither is sufficient alone and both are present.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, CalendarClock, Gift, RefreshCw, Search, Users } from 'lucide-react';
import { toast } from '@/lib/toast';
import { AdminButton } from '@/components/admin/AdminButton';
import type { SiteTier } from '@/lib/siteTier';
import type { BillingState } from '@/lib/types/customer';
import type {
  AdminBillingCustomer,
  AdminBillingCustomerListResponse,
  AdminBillingOverrideResponse,
} from '@/lib/types/billingAdmin';

const ALL = 'all';

/** Rows pulled per refresh. Matches the route's ceiling. */
const PAGE_LIMIT = 500;

/** Keystroke settle time before the list refetches. */
const SEARCH_DEBOUNCE_MS = 250;

const STATE_OPTIONS: readonly BillingState[] = ['trialing', 'active', 'expired', 'canceled'];

/**
 * Badge styling per billing state, in theme tokens only.
 *
 * `active` takes the primary cyan (paying, nothing to do), `trialing` the warm
 * amber (a clock is running), `expired` the destructive red, and `canceled`
 * the muted grey — a closed account is not an alarm.
 */
const STATE_BADGE: Record<BillingState, string> = {
  trialing: 'bg-accent-warm/15 text-accent-warm border-accent-warm/30',
  active: 'bg-primary/15 text-primary border-primary/30',
  expired: 'bg-destructive/15 text-destructive border-destructive/30',
  canceled: 'bg-muted text-muted-foreground border-border',
};

type DialogKind = 'extend' | 'tier' | 'expire';

/** Absolute date for an epoch-ms value, or an em dash. */
function formatDate(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Whole days from now to `ms`; negative when past. `null` when unset. */
function daysFromNow(ms: number | null): number | null {
  if (ms === null) return null;
  return Math.ceil((ms - Date.now()) / (24 * 60 * 60 * 1000));
}

export default function AdminCustomersPage() {
  const [rows, setRows] = useState<AdminBillingCustomer[]>([]);
  const [matched, setMatched] = useState(0);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<string>(ALL);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [target, setTarget] = useState<AdminBillingCustomer | null>(null);
  const [days, setDays] = useState('14');
  const [tier, setTier] = useState<SiteTier>('pro');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Monotonic fetch counter. The search box refetches as the admin types, so a
  // slow earlier response must never overwrite a newer one — the table is what
  // the row actions target, and showing stale rows would aim an override at
  // the wrong account.
  const fetchSeq = useRef(0);

  const loadCustomers = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (query.trim()) params.set('q', query.trim());
      if (stateFilter !== ALL) params.set('state', stateFilter);

      const response = await fetch(`/api/admin/billing/customers?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = await response.json();
      if (seq !== fetchSeq.current) return;

      if (!response.ok) {
        throw new Error(data?.detail || data?.title || 'failed to load customers');
      }

      const body = data as AdminBillingCustomerListResponse;
      setRows(body.customers);
      setMatched(body.matched);
      setTotal(body.total);
      setTruncated(body.truncated);
      setLoadError(null);
    } catch (error: unknown) {
      if (seq !== fetchSeq.current) return;
      const message = error instanceof Error ? error.message : String(error);
      // Clear the table on failure: a stale row is a row an override could be
      // aimed at with the wrong billing state on screen.
      setRows([]);
      setLoadError(message);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [query, stateFilter]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCustomers();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [loadCustomers]);

  const openDialog = (kind: DialogKind, customer: AdminBillingCustomer) => {
    setTarget(customer);
    setDays('14');
    setTier(customer.subscriptionTier ?? 'pro');
    setNote('');
    setDialog(kind);
  };

  const closeDialog = () => {
    setDialog(null);
    setTarget(null);
  };

  const submitOverride = async (body: Record<string, unknown>) => {
    if (!target) return;
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/admin/billing/customers/${encodeURIComponent(target.uid)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail || data?.title || 'the override was rejected');
      }

      const result = data as AdminBillingOverrideResponse;
      toast.success('billing updated', {
        description: `${target.email ?? target.uid} is now ${result.billingState}`,
      });
      closeDialog();
      await loadCustomers();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('override failed', { description: message });
    } finally {
      setSubmitting(false);
    }
  };

  const parsedDays = Number(days);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365;
  const noteValid = note.trim().length > 0;

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">customers</h1>
            <p className="text-muted-foreground">
              extend trials, comp tiers, and end trials early. every change is audit-logged.
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void loadCustomers()}
            disabled={loading}
            aria-label="refresh customers"
            className="border-border text-foreground hover:bg-accent! hover:text-foreground!"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search email, name, or uid"
              aria-label="search customers"
              className="pl-9 bg-card border-border text-foreground"
            />
          </div>

          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger
              aria-label="filter by billing state"
              className="w-[170px] bg-card border-border text-foreground"
            >
              <SelectValue placeholder="all states" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value={ALL} className="text-foreground hover:bg-muted!">
                all states
              </SelectItem>
              {STATE_OPTIONS.map((s) => (
                <SelectItem key={s} value={s} className="text-foreground hover:bg-muted!">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="ml-auto text-sm text-muted-foreground whitespace-nowrap">
            {matched === total ? `${total} accounts` : `${matched} of ${total} accounts`}
            {truncated ? ` — showing the first ${rows.length}` : ''}
          </span>
        </div>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            {loading && rows.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">loading customers...</div>
            ) : loadError ? (
              <div className="text-center py-8 text-muted-foreground">
                <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-destructive opacity-80" />
                <p>could not load customers</p>
                <p className="text-sm mt-1">{loadError}</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>no accounts match these filters</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-card">
                      <TableHead className="text-foreground">account</TableHead>
                      <TableHead className="text-foreground">state</TableHead>
                      <TableHead className="text-foreground">tier</TableHead>
                      <TableHead className="text-foreground">trial ends</TableHead>
                      <TableHead className="text-foreground">subscription</TableHead>
                      <TableHead className="text-foreground text-right">actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const left = daysFromNow(row.trialEndsAt);
                      return (
                        <TableRow
                          key={row.uid}
                          data-testid={`customer-row-${row.uid}`}
                          className="border-border hover:bg-muted/40"
                        >
                          <TableCell className="text-foreground">
                            <div className="font-medium">{row.email ?? row.uid}</div>
                            <div className="text-xs text-muted-foreground">
                              {row.displayName ? `${row.displayName} · ` : ''}
                              {row.uid}
                              {row.deleted ? ' · deleted' : ''}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={STATE_BADGE[row.billingState]}>
                              {row.billingState}
                            </Badge>
                            {row.alertEmailsMuted && (
                              <div className="text-xs text-muted-foreground mt-1">alerts muted</div>
                            )}
                          </TableCell>
                          <TableCell className="text-foreground">
                            {row.subscriptionTier ?? '—'}
                            {row.comped && (
                              <Badge
                                variant="outline"
                                className="ml-2 bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30"
                              >
                                comped
                              </Badge>
                            )}
                            {row.comp?.note && (
                              <div className="text-xs text-muted-foreground mt-1 max-w-xs truncate">
                                {row.comp.note}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-foreground">
                            {formatDate(row.trialEndsAt)}
                            {left !== null && (
                              <div className="text-xs text-muted-foreground">
                                {left > 0 ? `${left} days left` : `${Math.abs(left)} days ago`}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.hasSubscription ? (row.subscriptionStatus ?? 'unknown') : 'none'}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openDialog('extend', row)}
                              className="text-foreground hover:bg-accent! hover:text-foreground!"
                            >
                              <CalendarClock className="h-4 w-4 mr-1" />
                              extend
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openDialog('tier', row)}
                              className="text-foreground hover:bg-accent! hover:text-foreground!"
                            >
                              <Gift className="h-4 w-4 mr-1" />
                              set tier
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openDialog('expire', row)}
                              className="text-destructive hover:bg-destructive/10! hover:text-destructive!"
                            >
                              <AlertTriangle className="h-4 w-4 mr-1" />
                              expire
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* extend trial */}
        <Dialog open={dialog === 'extend'} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="bg-background border-border">
            <DialogHeader>
              <DialogTitle>extend trial for {target?.email ?? target?.uid}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                adds days to the trial clock, counted from today when the trial has already
                lapsed. any trial reminder that is no longer in the past is un-stamped so it
                fires again, and a stale alert mute is lifted.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="extend-days" className="text-foreground">
                days to add
              </Label>
              <Input
                id="extend-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="bg-card border-border text-foreground"
              />
              {!daysValid && (
                <p className="text-sm text-destructive">
                  enter a whole number of days between 1 and 365
                </p>
              )}
            </div>
            <DialogFooter>
              <AdminButton adminVariant="card" onClick={closeDialog}>
                cancel
              </AdminButton>
              <Button
                onClick={() => void submitOverride({ operation: 'extend_trial', days: parsedDays })}
                disabled={submitting || !daysValid}
              >
                {submitting ? 'extending...' : `extend by ${daysValid ? parsedDays : 0} days`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* set tier */}
        <Dialog open={dialog === 'tier'} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="bg-background border-border">
            <DialogHeader>
              <DialogTitle>set tier for {target?.email ?? target?.uid}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                records a comp against this account. it does not create or change a stripe
                subscription — if the customer is paying, change the plan in stripe instead.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="comp-tier" className="text-foreground">
                  tier
                </Label>
                <Select value={tier} onValueChange={(v) => setTier(v as SiteTier)}>
                  <SelectTrigger
                    id="comp-tier"
                    className="bg-card border-border text-foreground"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="core" className="text-foreground hover:bg-muted!">
                      core
                    </SelectItem>
                    <SelectItem value="pro" className="text-foreground hover:bg-muted!">
                      pro
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="comp-note" className="text-foreground">
                  reason
                </Label>
                <Textarea
                  id="comp-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="why this account is being comped"
                  className="bg-card border-border text-foreground"
                />
                {!noteValid && (
                  <p className="text-sm text-destructive">a reason is required</p>
                )}
              </div>
            </div>
            <DialogFooter>
              <AdminButton adminVariant="card" onClick={closeDialog}>
                cancel
              </AdminButton>
              <Button
                onClick={() =>
                  void submitOverride({ operation: 'set_tier', tier, note: note.trim() })
                }
                disabled={submitting || !noteValid}
              >
                {submitting ? 'saving...' : `comp to ${tier}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* force expire */}
        <Dialog open={dialog === 'expire'} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="bg-background border-border">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                end the trial for {target?.email ?? target?.uid}?
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                the trial clock is set to a moment ago, which locks the account out of
                control-plane actions immediately. dashboards stay readable and no data is
                deleted. an account with a live stripe subscription is unaffected — stripe stays
                authoritative.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <AdminButton adminVariant="card" onClick={closeDialog}>
                cancel
              </AdminButton>
              <Button
                variant="destructive"
                onClick={() => void submitOverride({ operation: 'force_expire' })}
                disabled={submitting}
              >
                {submitting ? 'expiring...' : 'end trial now'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
