'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/PageHeader';
import { collection, query, orderBy, limit, getDocs, where, startAfter, Query, DocumentData, Timestamp, onSnapshot, writeBatch, doc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronsUpDown, ChevronsDownUp, Filter, X, Trash2, ScrollText, AlertTriangle, AlertCircle, Camera } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import ConfirmDialog from '@/components/ConfirmDialog';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import DownloadButton from '@/components/DownloadButton';

interface LogEvent {
  id: string;
  timestamp: Timestamp;
  action: string;
  level: string;
  machineId: string;
  machineName: string;
  processName?: string;
  details?: string;
  userId?: string;
  screenshotUrl?: string;
}

const LOGS_PER_PAGE = 50;

// Date range presets
type DatePreset = 'all' | 'last_hour' | 'last_24h' | 'today' | 'yesterday' | 'last_7' | 'last_30' | 'this_week' | 'this_month' | 'last_month' | 'custom';

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'all time' },
  { value: 'last_hour', label: 'last hour' },
  { value: 'last_24h', label: 'last 24 hours' },
  { value: 'today', label: 'today' },
  { value: 'yesterday', label: 'yesterday' },
  { value: 'last_7', label: 'last 7 days' },
  { value: 'last_30', label: 'last 30 days' },
  { value: 'this_week', label: 'this week' },
  { value: 'this_month', label: 'this month' },
  { value: 'last_month', label: 'last month' },
  { value: 'custom', label: 'custom range' },
];

function getDateRange(preset: DatePreset, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (preset) {
    case 'all':
      return { from: null, to: null };
    case 'last_hour': {
      const d = new Date(now);
      d.setHours(d.getHours() - 1);
      return { from: d, to: now };
    }
    case 'last_24h': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { from: d, to: now };
    }
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'last_7': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'last_30': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'this_week': {
      const d = new Date(now);
      const day = d.getDay();
      // Monday as start of week
      const diff = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diff);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'this_month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from, to };
    }
    case 'custom': {
      const from = customFrom ? startOfDay(new Date(customFrom + 'T00:00:00')) : null;
      const to = customTo ? endOfDay(new Date(customTo + 'T00:00:00')) : null;
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

// Action type labels for filtering
const ACTION_TYPES = [
  { value: 'all', label: 'all actions' },
  { value: 'agent_started', label: 'agent started' },
  { value: 'agent_stopped', label: 'agent stopped' },
  { value: 'process_started', label: 'process started' },
  { value: 'process_killed', label: 'process killed' },
  { value: 'process_crash', label: 'process crashed' },
  { value: 'process_start_failed', label: 'start failed' },
  { value: 'command_executed', label: 'command executed' },
  { value: 'deployment_completed', label: 'deployment completed' },
  { value: 'deployment_failed', label: 'deployment failed' },
  { value: 'deployment_cancelled', label: 'deployment cancelled' },
  { value: 'scheduled_reboot', label: 'scheduled reboot' },
];

// Level badges styling
const getLevelBadge = (level: string) => {
  switch (level.toLowerCase()) {
    case 'error':
      return <Badge variant="destructive" className="text-xs">error</Badge>;
    case 'warning':
      return <Badge variant="default" className="bg-yellow-600 text-xs">warning</Badge>;
    case 'info':
      return <Badge variant="default" className="bg-accent-cyan text-gray-900 text-xs">info</Badge>;
    default:
      return <Badge variant="outline" className="text-xs">{level}</Badge>;
  }
};

// Format action for display
const formatAction = (action: string) => {
  return action
    .split('_')
    .join(' ');
};

export default function LogsPage() {
  const router = useRouter();
  const { user, loading, isAdmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(user?.uid, userSites, isAdmin);
  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [lastDoc, setLastDoc] = useState<DocumentData | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Filters
  const [filterAction, setFilterAction] = useState<string>('all');
  const [filterMachine, setFilterMachine] = useState<string>('all');
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [filterDatePreset, setFilterDatePreset] = useState<DatePreset>('all');
  const [filterDateFrom, setFilterDateFrom] = useState<string>('');
  const [filterDateTo, setFilterDateTo] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);

  // Clear logs confirmation dialog
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [screenshotModalUrl, setScreenshotModalUrl] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  // Site management dialogs
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Account settings dialog
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);

  // Expanded log rows (multi-expand)
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());

  // Infinite scroll
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const toggleLogExpanded = useCallback((logId: string) => {
    setExpandedLogIds(prev => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  }, []);

  const allExpanded = logs.length > 0 && expandedLogIds.size === logs.length;

  const toggleAllExpanded = useCallback(() => {
    if (allExpanded) {
      setExpandedLogIds(new Set());
    } else {
      setExpandedLogIds(new Set(logs.map(l => l.id)));
    }
  }, [allExpanded, logs]);

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (!sitesLoading && sites.length > 0 && !currentSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setCurrentSiteId(savedSite);
      } else {
        setCurrentSiteId(sites[0].id);
      }
    }
  }, [sites, sitesLoading, currentSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setCurrentSiteId(siteId);
    updateLastSite(siteId);
  };

  // Real-time logs listener for initial batch
  useEffect(() => {
    if (!currentSiteId || !db) return;

    setLogsLoading(true);
    setExpandedLogIds(new Set());

    // Compute date range from preset
    const dateRange = getDateRange(filterDatePreset, filterDateFrom, filterDateTo);

    // Check if any non-date filters are active (date filters use orderBy-compatible where clauses)
    const hasNonDateFilters = filterAction !== 'all' || filterMachine !== 'all' || filterLevel !== 'all';

    // Build query with filters
    const logsRef = collection(db, 'sites', currentSiteId, 'logs');
    let q: Query;

    // Always use orderBy('timestamp', 'desc') — date range filters are compatible with it.
    // Only skip orderBy when non-date filters are active without a composite index.
    if (hasNonDateFilters) {
      q = query(logsRef, limit(LOGS_PER_PAGE + 1));
    } else {
      q = query(logsRef, orderBy('timestamp', 'desc'), limit(LOGS_PER_PAGE + 1));
    }

    // Apply filters
    if (filterAction !== 'all') {
      q = query(q, where('action', '==', filterAction));
    }
    if (filterMachine !== 'all') {
      q = query(q, where('machineId', '==', filterMachine));
    }
    if (filterLevel !== 'all') {
      q = query(q, where('level', '==', filterLevel));
    }
    // Date range filters — applied client-side when non-date filters are active (no composite index),
    // or via Firestore where clauses when only date filters are active
    if (!hasNonDateFilters) {
      if (dateRange.from) {
        q = query(q, where('timestamp', '>=', Timestamp.fromDate(dateRange.from)));
      }
      if (dateRange.to) {
        q = query(q, where('timestamp', '<=', Timestamp.fromDate(dateRange.to)));
      }
    }

    // Set up real-time listener
    const unsubscribe = onSnapshot(q, (snapshot) => {
      let docsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as LogEvent));

      // Sort client-side by timestamp if non-date filters are active
      if (hasNonDateFilters) {
        docsData.sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis());
      }

      // Apply date range client-side when non-date filters are active
      if (hasNonDateFilters && (dateRange.from || dateRange.to)) {
        docsData = docsData.filter(log => {
          const ts = log.timestamp.toMillis();
          if (dateRange.from && ts < dateRange.from.getTime()) return false;
          if (dateRange.to && ts > dateRange.to.getTime()) return false;
          return true;
        });
      }

      // Check if there are more pages
      const hasMoreData = docsData.length > LOGS_PER_PAGE;
      setHasMore(hasMoreData);

      // Remove the extra document used for pagination check
      const displayLogs = hasMoreData ? docsData.slice(0, LOGS_PER_PAGE) : docsData;

      setLogs(displayLogs);

      // Set pagination marker for infinite scroll
      if (displayLogs.length > 0) {
        setLastDoc(snapshot.docs[Math.min(LOGS_PER_PAGE - 1, snapshot.docs.length - 1)]);
      }

      setLogsLoading(false);
    }, (error) => {
      console.error('Error in logs listener:', error);
      setLogsLoading(false);
    });

    // Cleanup listener on unmount or when dependencies change
    return () => unsubscribe();
  }, [currentSiteId, filterAction, filterMachine, filterLevel, filterDatePreset, filterDateFrom, filterDateTo]);

  // Infinite scroll — load more logs
  const loadMore = useCallback(async () => {
    if (!currentSiteId || !db || !lastDoc || !hasMore || isFetchingMore) return;

    setIsFetchingMore(true);

    try {
      const dateRange = getDateRange(filterDatePreset, filterDateFrom, filterDateTo);
      const logsRef = collection(db, 'sites', currentSiteId, 'logs');
      let q = query(logsRef, orderBy('timestamp', 'desc'), startAfter(lastDoc), limit(LOGS_PER_PAGE + 1));

      if (filterAction !== 'all') q = query(q, where('action', '==', filterAction));
      if (filterMachine !== 'all') q = query(q, where('machineId', '==', filterMachine));
      if (filterLevel !== 'all') q = query(q, where('level', '==', filterLevel));
      if (dateRange.from) q = query(q, where('timestamp', '>=', Timestamp.fromDate(dateRange.from)));
      if (dateRange.to) q = query(q, where('timestamp', '<=', Timestamp.fromDate(dateRange.to)));

      const snapshot = await getDocs(q);
      const docsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as LogEvent));

      const hasMoreData = docsData.length > LOGS_PER_PAGE;
      setHasMore(hasMoreData);

      const newLogs = hasMoreData ? docsData.slice(0, LOGS_PER_PAGE) : docsData;

      if (newLogs.length > 0) {
        setLogs(prev => [...prev, ...newLogs]);
        setLastDoc(snapshot.docs[Math.min(LOGS_PER_PAGE - 1, snapshot.docs.length - 1)]);
      }
    } catch (error) {
      console.error('Error loading more logs:', error);
    } finally {
      setIsFetchingMore(false);
    }
  }, [currentSiteId, lastDoc, hasMore, isFetchingMore, filterAction, filterMachine, filterLevel, filterDatePreset, filterDateFrom, filterDateTo]);

  // IntersectionObserver for infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isFetchingMore) {
          loadMore();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, loadMore]);

  const resetFilters = () => {
    setFilterAction('all');
    setFilterMachine('all');
    setFilterLevel('all');
    setFilterDatePreset('all');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  const handleClearLogs = async () => {
    if (!currentSiteId || !db) return;

    setIsClearing(true);

    try {
      // Build query with same filters as the display
      const logsRef = collection(db, 'sites', currentSiteId, 'logs');
      let q: Query = query(logsRef);

      // Apply filters to match current view
      if (filterAction !== 'all') {
        q = query(q, where('action', '==', filterAction));
      }
      if (filterMachine !== 'all') {
        q = query(q, where('machineId', '==', filterMachine));
      }
      if (filterLevel !== 'all') {
        q = query(q, where('level', '==', filterLevel));
      }

      // Fetch all matching logs
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        console.log('No logs to delete');
        setIsClearing(false);
        return;
      }

      // Delete in batches (Firestore limit is 500 per batch)
      const batchSize = 500;
      const batches = [];
      let batch = writeBatch(db);
      let operationCount = 0;

      snapshot.docs.forEach((document) => {
        batch.delete(doc(db!, 'sites', currentSiteId, 'logs', document.id));
        operationCount++;

        if (operationCount === batchSize) {
          batches.push(batch.commit());
          batch = writeBatch(db!);
          operationCount = 0;
        }
      });

      // Commit remaining operations
      if (operationCount > 0) {
        batches.push(batch.commit());
      }

      // Wait for all batches to complete
      await Promise.all(batches);

      console.log(`Deleted ${snapshot.docs.length} log entries`);

      // Logs will refresh via the real-time listener
      setLogs([]);

    } catch (error) {
      console.error('Error clearing logs:', error);
    } finally {
      setIsClearing(false);
    }
  };

  // Get unique machines for filter
  const uniqueMachines = Array.from(new Set(logs.map(log => log.machineId)));

  if (loading || sitesLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">loading...</div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen pb-8">
      <PageHeader
        currentPage="logs"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      {/* Site Management Dialogs */}
      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        machineCount={0}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          // If we deleted the current site, switch to another one
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter(s => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
      />

      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />

      {/* Main content */}
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        {/* Section header with inline stats */}
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-6 md:gap-8">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">logs</h2>

            <div className="flex items-center gap-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${logs.length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <ScrollText className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{logs.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">events</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${logs.filter(l => l.level === 'warning').length > 0 ? 'bg-yellow-500/10 text-yellow-400' : 'bg-muted text-muted-foreground'}`}>
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${logs.filter(l => l.level === 'warning').length > 0 ? 'text-yellow-400' : 'text-foreground'}`}>{logs.filter(l => l.level === 'warning').length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">warnings</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${logs.filter(l => l.level === 'error').length > 0 ? 'bg-red-500/10 text-red-400' : 'bg-muted text-muted-foreground'}`}>
                  <AlertCircle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${logs.filter(l => l.level === 'error').length > 0 ? 'text-red-400' : 'text-foreground'}`}>{logs.filter(l => l.level === 'error').length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">errors</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {logs.length > 0 && (
              <Button
                variant="outline"
                onClick={toggleAllExpanded}
                className="hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                title={allExpanded ? 'collapse all' : 'expand all'}
                size="icon"
              >
                {allExpanded ? <ChevronsDownUp className="w-4 h-4" /> : <ChevronsUpDown className="w-4 h-4" />}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setShowFilters(!showFilters)}
              className="gap-2 hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            >
              <Filter className="w-4 h-4" />
              {showFilters ? 'hide filters' : 'show filters'}
            </Button>
            <Button
              onClick={() => setShowClearDialog(true)}
              disabled={isClearing || logs.length === 0}
              variant="outline"
              className="gap-2 border-red-400/60 text-red-400 hover:bg-red-950/50 hover:text-red-300 transition-colors cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
              {isClearing ? 'clearing...' : 'clear logs'}
            </Button>
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <Card className="p-4 bg-card border-border mb-6">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div>
                <Label className="text-foreground text-sm mb-2">action type</Label>
                <Select value={filterAction} onValueChange={setFilterAction}>
                  <SelectTrigger className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTION_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-foreground text-sm mb-2">machine</Label>
                <Select value={filterMachine} onValueChange={setFilterMachine}>
                  <SelectTrigger className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all machines</SelectItem>
                    {uniqueMachines.map(machine => (
                      <SelectItem key={machine} value={machine}>
                        {machine}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-foreground text-sm mb-2">level</Label>
                <Select value={filterLevel} onValueChange={setFilterLevel}>
                  <SelectTrigger className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all levels</SelectItem>
                    <SelectItem value="info">info</SelectItem>
                    <SelectItem value="warning">warning</SelectItem>
                    <SelectItem value="error">error</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-foreground text-sm mb-2">date range</Label>
                <Select value={filterDatePreset} onValueChange={(v) => setFilterDatePreset(v as DatePreset)}>
                  <SelectTrigger className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_PRESETS.map(preset => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-foreground text-sm mb-2">&nbsp;</Label>
                <Button
                  variant="outline"
                  onClick={resetFilters}
                  className="w-full gap-2"
                >
                  <X className="w-4 h-4" />
                  reset filters
                </Button>
              </div>
            </div>

            {/* Custom date range inputs */}
            {filterDatePreset === 'custom' && (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mt-4 pt-4 border-t border-border/50">
                <div>
                  <Label className="text-foreground text-sm mb-2">from</Label>
                  <Input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="bg-muted border-border"
                  />
                </div>
                <div>
                  <Label className="text-foreground text-sm mb-2">to</Label>
                  <Input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="bg-muted border-border"
                  />
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Logs List */}
        <Card className="bg-card border-border">
          <div className="divide-y divide-border">
            {logsLoading ? (
              <div className="p-8 text-center text-muted-foreground">
                loading logs...
              </div>
            ) : logs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                no logs found for this site
              </div>
            ) : (
              logs.map((log) => {
                const isExpanded = expandedLogIds.has(log.id);
                return (
                  <div
                    key={log.id}
                    className={`group/row px-4 py-3 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0 ${isExpanded ? 'bg-muted/30' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <button
                          type="button"
                          onClick={() => toggleLogExpanded(log.id)}
                          className="group/expand flex items-center gap-3 cursor-pointer hover:opacity-80 flex-shrink-0"
                        >
                          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover/row:opacity-100 transition-all ${isExpanded ? 'opacity-100 rotate-180' : ''}`} />
                          <div className="w-[52px] flex-shrink-0">{getLevelBadge(log.level)}</div>
                          <span className="text-foreground font-medium whitespace-nowrap w-[140px] flex-shrink-0 text-left">
                            {formatAction(log.action)}
                          </span>
                        </button>
                        <span className="text-muted-foreground">•</span>
                        <span className="text-foreground whitespace-nowrap">{log.machineName}</span>
                        {log.processName && (
                          <>
                            <span className="text-muted-foreground">•</span>
                            <span className="text-foreground whitespace-nowrap">{log.processName}</span>
                          </>
                        )}
                        {!isExpanded && log.screenshotUrl && (
                          <>
                            <span className="text-muted-foreground">•</span>
                            <Camera className="w-3 h-3 text-muted-foreground" />
                          </>
                        )}
                        {!isExpanded && log.details && (
                          <>
                            <span className="text-muted-foreground">•</span>
                            <span className="text-muted-foreground truncate">{log.details}</span>
                          </>
                        )}
                      </div>
                      <div className="text-muted-foreground whitespace-nowrap text-xs">
                        {log.timestamp?.toDate().toLocaleString()}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-border/50 text-sm flex gap-6">
                        <div className="flex-shrink-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 self-start">
                          <span className="text-muted-foreground">machine id</span>
                          <span className="text-foreground text-xs font-mono">{log.machineId}</span>
                          {log.userId && (
                            <>
                              <span className="text-muted-foreground">user</span>
                              <span className="text-foreground text-xs font-mono">{log.userId}</span>
                            </>
                          )}
                          <span className="text-muted-foreground">timestamp</span>
                          <span className="text-foreground">{log.timestamp?.toDate().toLocaleString()}</span>
                        </div>
                        {log.details && (
                          <div className="flex-1 min-w-0 border-l border-border/50 pl-6">
                            <span className="text-muted-foreground text-xs">details</span>
                            <p className="text-foreground mt-1 whitespace-pre-wrap break-words select-text">{log.details}</p>
                          </div>
                        )}
                        {log.screenshotUrl && (
                          <div className="flex-shrink-0 border-l border-border/50 pl-6">
                            <span className="text-muted-foreground text-xs">crash screenshot</span>
                            <button onClick={() => setScreenshotModalUrl(log.screenshotUrl!)} className="block mt-1">
                              <img
                                src={log.screenshotUrl}
                                alt="Crash screenshot"
                                className="rounded border border-border/50 max-w-[200px] max-h-[120px] object-cover hover:opacity-80 transition-opacity cursor-pointer"
                              />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1" />
        {isFetchingMore && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            loading more...
          </div>
        )}
      </main>

      {/* Screenshot Modal */}
      {screenshotModalUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 cursor-pointer"
          onClick={() => setScreenshotModalUrl(null)}
          onKeyDown={(e) => e.key === 'Escape' && setScreenshotModalUrl(null)}
        >
          <img
            src={screenshotModalUrl}
            alt="Crash screenshot"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setScreenshotModalUrl(null)}
            className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Clear Logs Confirmation Dialog */}
      <ConfirmDialog
        open={showClearDialog}
        onOpenChange={setShowClearDialog}
        title="clear event logs"
        description={
          filterAction !== 'all' || filterMachine !== 'all' || filterLevel !== 'all'
            ? `this will permanently delete all logs matching the current filters.\n\nfilters active:\n${filterAction !== 'all' ? `• action: ${ACTION_TYPES.find(t => t.value === filterAction)?.label}\n` : ''}${filterMachine !== 'all' ? `• machine: ${filterMachine}\n` : ''}${filterLevel !== 'all' ? `• level: ${filterLevel}\n` : ''}\nthis action cannot be undone.`
            : `this will permanently delete ALL event logs for this site (across all machines).\n\nthis action cannot be undone.`
        }
        confirmText="clear logs"
        cancelText="cancel"
        onConfirm={handleClearLogs}
        variant="destructive"
      />
    </div>
  );
}
