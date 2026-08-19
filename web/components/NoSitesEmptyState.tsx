'use client';

/**
 * Terminal state for a site-scoped page when the caller has no sites.
 *
 * Exists because /deployments, /logs and /roosts previously had no branch for
 * this case at all: their render gates folded "no site selected" into the
 * loading condition, so an account with zero sites sat on a spinner forever
 * with no error and no next step. Render this instead of a spinner whenever
 * `hasNoSites` from `useCurrentSite` is true.
 */

import { Card } from '@/components/ui/card';

interface NoSitesEmptyStateProps {
  /**
   * What the caller cannot do yet, e.g. "manage roosts". Completes the
   * sentence "you need site access to …".
   */
  action: string;
}

export function NoSitesEmptyState({ action }: NoSitesEmptyStateProps) {
  return (
    <Card className="border-border bg-card/50 p-8 text-center">
      <p className="text-sm text-foreground">no sites available</p>
      <p className="mt-1 text-xs text-muted-foreground">
        you need site access to {action}. create a site from the dashboard, or ask a
        site admin to add you.
      </p>
    </Card>
  );
}
