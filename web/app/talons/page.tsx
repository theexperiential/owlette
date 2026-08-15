'use client';

/**
 * `/talons` — the automation list: trigger → condition → outputs, one dense
 * row per talon in an aligned-column list, with run history behind each row's
 * chevron.
 *
 * Standard page shell (header + site switcher + site dialogs) copied from
 * `/roosts` and `/deployments`, so switching sites here behaves exactly as it
 * does everywhere else and the choice follows the user to the next page.
 *
 * talons wave 4.2.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Zap } from 'lucide-react';

import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import DownloadButton from '@/components/DownloadButton';
import { LoadingWord } from '@/components/LoadingWord';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { PageHeader } from '@/components/PageHeader';
import { ProTierGate } from '@/components/billing/ProTierGate';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines, useSites } from '@/hooks/useFirestore';
import { useSiteTier } from '@/hooks/useSiteTier';
import { useTalons } from '@/hooks/useTalons';

import { TALON_ROW_GRID, TalonCard } from './components/TalonCard';
import { TalonEditorDialog } from './components/TalonEditorDialog';

/**
 * The talon shape the list hook streams. Derived from the hook rather than
 * imported by name so the page, the card, and the editor all agree on one
 * definition — the hook owns it.
 */
type TalonListEntry = ReturnType<typeof useTalons>['talons'][number];

export default function TalonsPage() {
  const router = useRouter();
  const {
    user,
    loading: authLoading,
    userSites,
    isSuperadmin,
    isSiteAdmin,
    lastSiteId,
    updateLastSite,
  } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(
    user?.uid,
    userSites,
    isSuperadmin,
  );

  // User's explicit pick wins once made; otherwise fall back to the last site
  // (Firestore-synced), then localStorage, then the first accessible site.
  // Derived during render rather than synced through an effect — same as
  // `/roosts` — so a changing site list can't cascade re-renders.
  const [userPickedSiteId, setUserPickedSiteId] = useState<string>('');
  const currentSiteId = useMemo(() => {
    if (userPickedSiteId && sites.some((s) => s.id === userPickedSiteId)) {
      return userPickedSiteId;
    }
    if (sitesLoading || sites.length === 0) return '';
    const savedSite =
      lastSiteId ||
      (typeof window !== 'undefined' ? localStorage.getItem('owlette_current_site') : null);
    if (savedSite && sites.some((s) => s.id === savedSite)) return savedSite;
    return sites[0].id;
  }, [userPickedSiteId, sites, sitesLoading, lastSiteId]);

  const { machines } = useMachines(currentSiteId);
  const { talons, loading: talonsLoading, error } = useTalons(currentSiteId);
  const siteTier = useSiteTier(currentSiteId);

  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // The talon the editor is opened on. `null` = create mode.
  const [editingTalon, setEditingTalon] = useState<TalonListEntry | null>(null);

  const handleSiteChange = (siteId: string) => {
    setUserPickedSiteId(siteId);
    updateLastSite(siteId);
  };

  const openCreate = () => {
    setEditingTalon(null);
    setEditorOpen(true);
  };

  const openEdit = (talon: TalonListEntry) => {
    setEditingTalon(talon);
    setEditorOpen(true);
  };

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">
          <LoadingWord />
        </p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  // `sitesLoading` folds into the loading branch, and the branch runs BEFORE
  // the no-sites card: an empty list before the first response is "unknown",
  // not "none" — rendering either empty state early flashes the wrong answer
  // at every user who does have sites and talons.
  const loading = sitesLoading || talonsLoading;

  return (
    <div className="relative min-h-screen pb-8">
      <PageHeader
        currentPage="Talons"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter((s) => s.id !== siteId);
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
        onSiteCreated={(siteId) => setUserPickedSiteId(siteId)}
      />

      <AccountSettingsDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen} />

      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        <div className="mb-6 mt-3 flex flex-col gap-4 md:mt-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
              talons
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              automate the checks you would otherwise do by hand — a trigger, an optional look at
              the screen, and what should happen next.
            </p>
          </div>

          {/* Creation is the only pro-gated talon operation — `POST
              /api/sites/{siteId}/talons` carries `requirePro`, while listing,
              running, toggling, and deleting stay open so a downgraded site
              keeps every control the api would still honour. */}
          <ProTierGate tier={siteTier} variant="inline" item="talons" className="flex-shrink-0">
            <Button
              type="button"
              data-testid="talon-create"
              onClick={openCreate}
              disabled={!currentSiteId}
              className="cursor-pointer text-gray-900"
            >
              <Plus className="mr-2 h-4 w-4" />
              create talon
            </Button>
          </ProTierGate>
        </div>

        {/* Ahead of the loading branch: `loading` is derived from "the listener
            has not delivered this site yet", which a failed listener never
            does — checking it second would spin forever. */}
        {error ? (
          <Card className="border-border bg-card/50 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              failed to load talons — try refreshing the page.
            </p>
          </Card>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !currentSiteId ? (
          <Card className="border-border bg-card/50 p-8 text-center">
            <p className="text-sm text-foreground">no sites available</p>
            <p className="mt-1 text-xs text-muted-foreground">
              you need site access to manage talons. ask a site admin to add you.
            </p>
          </Card>
        ) : talons.length === 0 ? (
          // Compact on purpose: this card sits where the list would, and must
          // not reserve height that pushes the rest of the page below the fold.
          <Card className="border-border bg-card/50 p-6 text-center">
            <Zap className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-foreground">no talons yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              a talon watches for something — a schedule, a threshold, an event — and acts on it.
            </p>
            <div className="mt-3 flex justify-center">
              <ProTierGate tier={siteTier} variant="inline" item="talons">
                <Button type="button" size="sm" onClick={openCreate} className="cursor-pointer text-gray-900">
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  create talon
                </Button>
              </ProTierGate>
            </div>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {/* Shares `TALON_ROW_GRID` with every row below it — one column
                definition, so the labels sit over the values they name. Hidden
                below `md`, where rows fall back to the stacked layout and
                column headings would be meaningless. No sort control: talons
                are capped at 20 per site. */}
            <div
              className={`hidden border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground ${TALON_ROW_GRID}`}
            >
              <span aria-hidden="true" />
              <span className="truncate">name</span>
              <span className="truncate">trigger</span>
              <span className="hidden truncate lg:block">outputs</span>
              <span className="hidden truncate xl:block">scope</span>
              <span className="truncate">last run</span>
              <span aria-hidden="true" />
            </div>

            <div className="divide-y divide-border">
              {talons.map((talon) => (
                <TalonCard
                  key={talon.id}
                  talon={talon}
                  siteId={currentSiteId}
                  machines={machines}
                  onEdit={() => openEdit(talon)}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {currentSiteId && (
        <TalonEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          siteId={currentSiteId}
          machines={machines.map((m) => ({
            // Machine docs are keyed by machineId, which is also the operator-
            // visible label throughout the app; TalonMachineOption wants id/name.
            id: m.machineId,
            name: m.machineId,
            online: m.online,
            processes: m.processes,
          }))}
          talon={editingTalon ?? undefined}
          isSiteAdmin={isSiteAdmin(currentSiteId)}
        />
      )}
    </div>
  );
}
