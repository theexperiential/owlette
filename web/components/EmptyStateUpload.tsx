'use client';

/**
 * EmptyStateUpload — first-run onboarding for /roosts (wave 3.9).
 *
 * Rendered on the roost page when the current site has zero synced folders.
 * Branches on machine count because the natural first-run blocker is
 * "no machines paired yet" — pushing a roost CTA at a user with no
 * targets to deploy to would be a dead-end click.
 *
 *   - machineCount === 0 → "install the agent on a machine first" onboarding,
 *     primary CTA opens the add-machine flow; new-roost button is present
 *     but secondary (still clickable — some users create a roost before
 *     pairing, which is fine since distributions can be created with zero
 *     targets).
 *   - machineCount >= 1 → "create your first roost" primary CTA.
 *
 * Three-step explainer strip sits below the primary action so first-time
 * users immediately see the shape of the workflow (drop folder → pick
 * machines → deploy) without opening the dialog.
 */

import { Button } from '@/components/ui/button';
import { FolderUp, MonitorSmartphone, Rocket, Plus, Download } from 'lucide-react';

interface EmptyStateUploadProps {
  machineCount: number;
  onNewRoost: () => void;
  onAddMachine?: () => void;
}

export function EmptyStateUpload({
  machineCount,
  onNewRoost,
  onAddMachine,
}: EmptyStateUploadProps) {
  const needsMachine = machineCount === 0;

  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div
        className="rounded-full bg-accent-cyan/10 p-4 mb-4"
        aria-hidden="true"
      >
        <FolderUp className="h-8 w-8 text-accent-cyan" />
      </div>

      <h3 className="text-lg font-semibold text-foreground mb-1">
        {needsMachine ? 'welcome to roost' : 'your first roost'}
      </h3>
      <p className="max-w-md text-sm text-muted-foreground">
        {needsMachine
          ? 'roost syncs folders from your dashboard to your windows machines. content-addressed chunks mean repeat deploys only move what changed.'
          : 'drop a folder to chunk, hash, and deploy it across your machines. only changed chunks are uploaded, so follow-up deploys are fast.'}
      </p>
      <p className="mt-2 max-w-md text-xs text-muted-foreground/80">
        roost is in developer preview — automatic webhook events, in-flight cancel, and post-reboot resume are still being hardened. data is durable.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {needsMachine && onAddMachine ? (
          <>
            <Button
              onClick={onAddMachine}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Download className="h-4 w-4 mr-2" />
              install agent
            </Button>
            <Button
              variant="outline"
              onClick={onNewRoost}
              className="cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              new roost
            </Button>
          </>
        ) : (
          <Button
            onClick={onNewRoost}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            new roost
          </Button>
        )}
      </div>

      <ol
        className="mt-10 grid w-full max-w-2xl grid-cols-1 gap-4 text-left sm:grid-cols-3"
        aria-label="how roost works"
      >
        <StepTile
          step={1}
          title="drop a folder"
          body="drag-drop or browse to pick what you want to sync. everything stays in your browser until you hit deploy."
          icon={<FolderUp className="h-4 w-4 text-accent-cyan" />}
        />
        <StepTile
          step={2}
          title="pick machines"
          body={
            needsMachine
              ? 'once you pair at least one machine, they show up as deploy targets here.'
              : `you have ${machineCount} machine${machineCount === 1 ? '' : 's'} ready. pick one or many as targets.`
          }
          icon={<MonitorSmartphone className="h-4 w-4 text-accent-cyan" />}
        />
        <StepTile
          step={3}
          title="deploy"
          body="roost uploads only new chunks, then each machine pulls the version and extracts atomically. rollback is one click."
          icon={<Rocket className="h-4 w-4 text-accent-cyan" />}
        />
      </ol>
    </div>
  );
}

interface StepTileProps {
  step: number;
  title: string;
  body: string;
  icon: React.ReactNode;
}

function StepTile({ step, title, body, icon }: StepTileProps) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-cyan/10 text-[11px] font-semibold text-accent-cyan tabular-nums"
          aria-hidden="true"
        >
          {step}
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          {icon}
          {title}
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
    </li>
  );
}

export default EmptyStateUpload;
