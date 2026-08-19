import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AppMenu } from '@/components/AppMenu'
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog'
import { DropConfirm } from '@/components/DropConfirm'
import { DropOverlay } from '@/components/DropOverlay'
import { JoinSiteDialog } from '@/components/JoinSiteDialog'
import { OwletteEye } from '@/components/landing/OwletteEye'
import { LeaveSiteDialog } from '@/components/LeaveSiteDialog'
import { ProcessDetail } from '@/components/ProcessDetail'
import { ProcessList, type ProcessAction } from '@/components/ProcessList'
import { ReportIssueDialog } from '@/components/ReportIssueDialog'
import { RestartCountdown } from '@/components/RestartCountdown'
import { SidebarDivider } from '@/components/SidebarDivider'
import { StatusFooter } from '@/components/StatusFooter'
import { WindowControls } from '@/components/WindowControls'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStates } from '@/hooks/useAppStates'
import { useFileDrop } from '@/hooks/useFileDrop'
import { useOwletteConfig } from '@/hooks/useOwletteConfig'
import { useRestartPrompt } from '@/hooks/useRestartPrompt'
import { useServiceHealth } from '@/hooks/useServiceHealth'
import { useSidebarLayout } from '@/hooks/useSidebarLayout'
import { isPaired, siteNameOf } from '@/lib/serviceHealth'
import { classifyDrop, toProcessEntry, type ProcessEntryDraft } from '@/lib/dropClassifier'
import {
  cardBlockedReason,
  dequeueCard,
  enqueueCards,
  triage,
  updateCard,
  type DropCard,
} from '@/lib/dropQueue'
import { classifyOptions, tauriFsProbe } from '@/lib/fsProbe'
import { hostname, setStartupLink, startupLinkEnabled, writeOwletteJson } from '@/lib/ipc'
import {
  addProcess,
  applyForm,
  createProcessEntry,
  duplicateProcess,
  findProcess,
  launchModeBlockedReason,
  launchModeOf,
  processesOf,
  removeProcess,
  reorderProcess,
  setLaunchMode,
  setPriority,
  setSchedules,
  setVisibility,
  updateProcess,
  type LaunchMode,
  type OwletteConfig,
  type Priority,
  type ProcessEntry,
  type ProcessForm,
  type ScheduleBlock,
  type Visibility,
} from '@/lib/owletteConfig'
import { launchedAtForProcess, livePidForProcess, statusForProcess } from '@/lib/processStatus'
import { NoLiveInstanceError, stopProcess, type StopMode } from '@/lib/processControl'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The dropped file's own name, for a toast that has to fit on one line. */
function fileNameOf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/**
 * The owlette configuration window.
 *
 * Everything on screen is a view over three files in `%PROGRAMDATA%\Owlette`
 * that the python service owns, and every change is a read-modify-write back
 * into them. There is no cloud client here on purpose: the service is the only
 * thing that talks to owlette, and it uploads the config it reads from disk
 * within seconds of a change (`owlette_gui.py:2403-2408`).
 */
function App() {
  const config = useOwletteConfig()
  const appStates = useAppStates()
  const health = useServiceHealth()
  const restartPrompt = useRestartPrompt()
  const sidebar = useSidebarLayout()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [dropped, setDropped] = useState<DropCard[]>([])
  const [menuDialog, setMenuDialog] = useState<'join' | 'leave' | 'report' | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [sidebarDragging, setSidebarDragging] = useState(false)
  // Whether the detail pane's advanced fields are folded away. Owned here, not
  // in the pane: the pane is remounted for every process (`key={selected.id}`),
  // so an operator who opened it to compare two entries would have it shut
  // itself on the second one. Deliberately not persisted — it is a reading
  // position within a session, not a preference about the machine.
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    hostname().then(setHost, () => setHost(null))
  }, [])

  const [startOnLogin, setStartOnLogin] = useState<boolean | null>(null)
  useEffect(() => {
    startupLinkEnabled().then(setStartOnLogin, () => setStartOnLogin(null))
  }, [])

  // The webview's native context menu (Back / Refresh / Print / Inspect) is
  // browser chrome, not this app. Suppress it in built apps everywhere except
  // editable fields, whose copy/paste menu is genuinely useful. `tauri dev`
  // keeps the native menu so Inspect stays reachable.
  useEffect(() => {
    if (import.meta.env.DEV) return
    const suppress = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    window.addEventListener('contextmenu', suppress)
    return () => window.removeEventListener('contextmenu', suppress)
  }, [])

  // What to call this machine's site anywhere an operator reads it. The id is
  // still what the logs and the config carry; this is the label.
  const siteLabel = siteNameOf(config.config, health.statusFile)

  /**
   * Whether this machine belongs to a site, and therefore whether the menu
   * offers leaving or joining. The footer reads the same verdict for its
   * `join site` button.
   */
  const paired = isPaired(config.config) === true

  const handleJoined = useCallback(() => {
    // The helper restarts the service; the config watcher picks up the new site
    // on its own, so there is nothing to reload here. The site goes unnamed on
    // purpose: pairing yields an id, and the name only arrives with the
    // restarted service's first status write a few seconds later — by which
    // time the footer says it.
    toast.success('this machine joined a site')
  }, [])

  const handleLeft = useCallback(() => {
    toast.success('this machine left its site')
  }, [])

  const processes = useMemo(
    () => (config.config ? processesOf(config.config) : []),
    [config.config],
  )
  const selected = selectedId
    ? (processes.find((process) => process.id === selectedId) ?? null)
    : null

  // A selection can disappear from under us — deleted here, or removed by the
  // web app while this window was open.
  useEffect(() => {
    if (selectedId && config.config && !findProcess(config.config, selectedId)) {
      setSelectedId(null)
    }
  }, [config.config, selectedId])

  const edit = useCallback(
    async (failure: string, transform: (document: OwletteConfig) => OwletteConfig) => {
      try {
        return await config.mutate(transform)
      } catch (cause) {
        toast.error(failure, { description: message(cause) })
        return null
      }
    },
    [config],
  )

  const editSelected = useCallback(
    (failure: string, update: (process: ProcessEntry) => ProcessEntry) => {
      if (!selectedId) return
      void edit(failure, (document) => updateProcess(document, selectedId, update))
    },
    [edit, selectedId],
  )

  const handleAdd = useCallback(async () => {
    const entry = createProcessEntry(crypto.randomUUID())
    const written = await edit('could not add the process', (document) =>
      addProcess(document, entry),
    )
    if (written) setSelectedId(entry.id)
  }, [edit])

  const handleDuplicate = useCallback(
    async (id: string) => {
      const cloneId = crypto.randomUUID()
      const written = await edit('could not duplicate the process', (document) =>
        duplicateProcess(document, id, cloneId),
      )
      if (written) setSelectedId(cloneId)
    },
    [edit],
  )

  /**
   * Files landed on the window.
   *
   * Classification is read-only — it stats paths and looks for host
   * applications — so it happens immediately; nothing is written until a card
   * is confirmed. Anything the classifier cannot place is reported here and
   * then forgotten, because there is no entry to propose for it.
   */
  const handleDrop = useCallback(async (paths: string[]) => {
    try {
      const results = await classifyDrop(paths, tauriFsProbe, await classifyOptions())
      const { cards, rejected } = triage(results)

      for (const drop of rejected) {
        toast.warning(`${fileNameOf(drop.path)} was not added`, { description: drop.reason })
      }
      if (cards.length) setDropped((queue) => enqueueCards(queue, cards))
    } catch (cause) {
      toast.error('could not read what was dropped', { description: message(cause) })
    }
  }, [])

  const dragOver = useFileDrop((paths) => void handleDrop(paths))

  /** The card being reviewed. The queue is worked from the front, one at a time. */
  const dropCard = dropped[0] ?? null
  const dropBlockedReason = dropCard
    ? cardBlockedReason(
        dropCard,
        processes.map((process) => String(process.name ?? '')),
      )
    : null

  const handleDropChange = useCallback((patch: Partial<ProcessEntryDraft>) => {
    setDropped((queue) => (queue.length ? updateCard(queue, queue[0].path, patch) : queue))
  }, [])

  /**
   * Add the reviewed card.
   *
   * The card leaves the queue before the write rather than after it, which
   * makes a second click on `add process` a no-op instead of a second entry.
   * The cost is a card lost if the write fails — and a write failing means
   * `config.json` cannot be read or replaced at all, which the next card would
   * hit just as hard.
   */
  const handleDropConfirm = useCallback(async () => {
    if (!dropCard) return

    const entry = toProcessEntry(
      {
        ...dropCard.entry,
        name: dropCard.entry.name.trim(),
        exe_path: dropCard.entry.exe_path.trim(),
      },
      crypto.randomUUID(),
    )

    setDropped((queue) => dequeueCard(queue, dropCard.path))
    const written = await edit('could not add the process', (document) =>
      addProcess(document, entry),
    )
    if (!written) return

    setSelectedId(entry.id)
    toast.success(`${entry.name} was added`, {
      description: 'its launch mode is off — nothing will start it until you change that',
    })
  }, [dropCard, edit])

  const handleDropSkip = useCallback(() => {
    setDropped((queue) => queue.slice(1))
  }, [])

  /** One write per drop — the drag itself never touches the file. */
  const handleReorder = useCallback(
    (id: string, toIndex: number) => {
      void edit('could not reorder the processes', (document) =>
        reorderProcess(document, id, toIndex),
      )
    },
    [edit],
  )

  const handleSaveForm = useCallback(
    (form: ProcessForm) => {
      editSelected('could not save the process', (process) => applyForm(process, form))
    },
    [editSelected],
  )

  /**
   * Switching a process out of `off` needs a name and an exe to launch; the
   * legacy GUI refuses the change with the same wording rather than writing a
   * launch mode the service cannot act on.
   */
  const handleLaunchMode = useCallback(
    (mode: LaunchMode) => {
      if (!selected) return
      const blocked = mode === 'off' ? null : launchModeBlockedReason(selected)
      if (blocked) {
        toast.warning(blocked)
        return
      }

      editSelected('could not change the launch mode', (process) => setLaunchMode(process, mode))

      // A process that stops being managed keeps its last live status in the
      // service's table forever — nothing is monitoring it any more to correct
      // the record — so the intent is written alongside the config change, as
      // `owlette_gui.on_launch_mode_change` does.
      const pid = livePidForProcess(appStates.states, selected.id)
      if (pid === null) return
      const intent = mode === 'off' ? 'INACTIVE' : 'QUEUED'
      if (statusForProcess(appStates.states, selected.id) === intent) return

      void appStates
        .mutate((states) => ({
          ...states,
          [String(pid)]: { ...states[String(pid)], status: intent, id: selected.id },
        }))
        .catch(() => {
          // Cosmetic: the service rewrites this file on its next tick anyway.
        })
    },
    [appStates, editSelected, selected],
  )

  const stop = useCallback(
    async (process: ProcessEntry, mode: StopMode) => {
      try {
        const result = await stopProcess(process, mode, {
          readStates: appStates.read,
          mutateStates: appStates.mutate,
        })

        const managed = launchModeOf(process) !== 'off'
        if (mode === 'kill') {
          toast.success(`${process.name} was killed`, {
            description: managed
              ? `pid ${result.pid} — the service will start it again, because its launch mode is not off`
              : `pid ${result.pid} — it stays stopped until you start it again`,
          })
        } else {
          toast.success(`${process.name} was stopped`, {
            description: managed
              ? `pid ${result.pid} — the service relaunches it within a few seconds`
              : `pid ${result.pid} — its launch mode is off, so nothing will start it again`,
          })
        }
      } catch (cause) {
        if (cause instanceof NoLiveInstanceError) toast.warning(cause.message)
        else toast.error(`could not ${mode} ${process.name}`, { description: message(cause) })
      }
    },
    [appStates],
  )

  const handleAction = useCallback(
    (action: ProcessAction, id: string) => {
      const process = processes.find((entry) => entry.id === id)
      if (!process) return
      const name = process.name || 'this process'
      const managed = launchModeOf(process) !== 'off'

      switch (action) {
        case 'duplicate':
          void handleDuplicate(id)
          return
        case 'delete':
          setConfirm({
            title: 'remove process',
            description: `remove ${name} from this machine? owlette will stop managing it. the process itself is left alone.`,
            confirmLabel: 'remove',
            destructive: true,
            onConfirm: () => {
              void edit('could not remove the process', (document) => removeProcess(document, id))
            },
          })
          return
        case 'restart':
          setConfirm({
            title: 'restart process',
            description: managed
              ? `restart ${name}? this will briefly stop the process before the service relaunches it.`
              : `restart ${name}? its launch mode is off, so the service will not start it again — this will only stop it.`,
            confirmLabel: 'restart',
            onConfirm: () => void stop(process, 'restart'),
          })
          return
        case 'kill':
          setConfirm({
            // A managed process comes back: `KILLED` tells the service the exit
            // was intentional so it does not raise a crash alert, but the
            // relaunch itself is decided by the launch mode alone
            // (`owlette_service.py:2486-2534`). Saying otherwise — as the legacy
            // GUI's wording does — sets the operator up for a surprise.
            title: 'kill process',
            description: managed
              ? `kill ${name}? it will be terminated, and because its launch mode is not off the service will start it again within a few seconds. set the launch mode to off first if you want it to stay stopped.`
              : `kill ${name}? it will be terminated and stays stopped until you start it again.`,
            confirmLabel: 'kill',
            destructive: true,
            onConfirm: () => void stop(process, 'kill'),
          })
      }
    },
    [edit, handleDuplicate, processes, stop],
  )

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col bg-background">
        {/*
          The window has no native titlebar (`decorations: false`), so this row
          is it: the drag surface, the one wordmark, and the window controls.
          `data-tauri-drag-region` applies only to the element carrying it, so
          the controls inside stay clickable without opting out.

          Double-click to maximise is deliberately NOT wired here. Tauri's own
          drag-region handler already does it — it watches `mousedown` and calls
          `internal_toggle_maximize` when `detail === 2` — so a `dblclick`
          handler of ours fires a *second* toggle a few milliseconds later and
          the window lands back where it started. Measured: with both in place
          three double-clicks produced one state change; with only Tauri's, each
          one toggles. The permission that makes it work is
          `core:window:allow-internal-toggle-maximize`.
        */}
        <header
          data-tauri-drag-region
          data-titlebar
          // relative z-[60] lifts the titlebar above dialog overlays (z-50), and
          // pointer-events-auto re-enables it under the pointer-events:none that
          // Radix puts on <body> while a modal is open — so the window can be
          // moved with a dialog up. DialogContent exempts [data-titlebar] from
          // its outside-dismiss for the same reason.
          className="pointer-events-auto relative z-[60] flex h-10 shrink-0 select-none items-center gap-2.5 border-b pl-4"
        >
          <OwletteEye size={18} className="pointer-events-none" />
          <span className="pointer-events-none text-sm font-medium tracking-tight">owlette</span>
          <span data-tauri-drag-region className="h-full flex-1" />
          <AppMenu
            paired={paired}
            onJoinSite={() => setMenuDialog('join')}
            onLeaveSite={() => setMenuDialog('leave')}
            onReportIssue={() => setMenuDialog('report')}
            startOnLogin={startOnLogin}
            onStartOnLoginChange={(next) => {
              void setStartupLink(next).then(setStartOnLogin, (cause: unknown) =>
                toast.error('could not change start on login', { description: message(cause) }),
              )
            }}
            onRestartService={() => {
              // The service polls for this file each loop and exits 42; the
              // host relaunches it. No elevation, no dashboard flap.
              void writeOwletteJson('tmp/restart.flag', {}).then(
                () => toast.success('restarting the owlette service'),
                (cause: unknown) => toast.error('could not restart the service', { description: message(cause) }),
              )
            }}
          />
          <WindowControls />
        </header>

        {config.error && (
          <InlineNotice className="m-3" data-testid="config-error">
            <p className="text-sm">
              could not read config.json — showing the last copy this window read.
            </p>
            <p className="font-mono text-xs text-muted-foreground">{config.error}</p>
          </InlineNotice>
        )}

        <div className="flex min-h-0 flex-1">
          {/*
            The width is remembered per user by the host, so it arrives a tick
            after mount; until then this is the width the sidebar always had.
            The divider carries the border the aside used to draw — one line,
            not two.
          */}
          <aside
            className={
              // Eased slide for toggle/keyboard collapse — but never while a
              // drag is tracking the pointer, where easing reads as lag.
              sidebarDragging
                ? 'min-w-0 shrink-0'
                : 'min-w-0 shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none'
            }
            style={{ width: sidebar.columnWidth }}
          >
            <ProcessList
              processes={processes}
              states={appStates.states}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={() => void handleAdd()}
              onAction={handleAction}
              onReorder={handleReorder}
              dragOver={dragOver}
              collapsed={sidebar.collapsed}
              onCollapsedChange={sidebar.setCollapsed}
            />
          </aside>

          <SidebarDivider
            layout={{ collapsed: sidebar.collapsed, width: sidebar.width }}
            onLayout={sidebar.set}
            onCommit={sidebar.commit}
            onDraggingChange={setSidebarDragging}
          />

          <section className="min-w-0 flex-1">
            {selected ? (
              <ProcessDetail
                key={selected.id}
                process={selected}
                status={statusForProcess(appStates.states, selected.id)}
                startedAt={launchedAtForProcess(appStates.states, selected.id)}
                advancedOpen={advancedOpen}
                onAdvancedOpenChange={setAdvancedOpen}
                onSave={handleSaveForm}
                onLaunchMode={handleLaunchMode}
                onSchedules={(schedules: ScheduleBlock[]) =>
                  editSelected('could not save the schedule', (process) =>
                    setSchedules(process, schedules),
                  )
                }
                onPriority={(priority: Priority) =>
                  editSelected('could not change the priority', (process) =>
                    setPriority(process, priority),
                  )
                }
                onVisibility={(visibility: Visibility) =>
                  editSelected('could not change the visibility', (process) =>
                    setVisibility(process, visibility),
                  )
                }
                onRestart={() => handleAction('restart', selected.id)}
                onKill={() => handleAction('kill', selected.id)}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {config.loading ? 'reading config.json…' : 'select a process to view its details'}
                </p>
              </div>
            )}
          </section>
        </div>

        <StatusFooter
          status={health.status}
          statusFile={health.statusFile}
          config={config.config}
          hostname={host}
          starting={health.starting}
          onStart={() => void health.start()}
          onJoin={() => setMenuDialog('join')}
        />

        <JoinSiteDialog
          open={menuDialog === 'join'}
          onClose={() => setMenuDialog(null)}
          onJoined={handleJoined}
        />
        <LeaveSiteDialog
          open={menuDialog === 'leave'}
          site={siteLabel}
          onClose={() => setMenuDialog(null)}
          onLeft={handleLeft}
          onHold={health.hold}
        />
        <ReportIssueDialog open={menuDialog === 'report'} onClose={() => setMenuDialog(null)} />
        <RestartCountdown open={restartPrompt.armed} onClose={restartPrompt.dismiss} />

        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        <DropConfirm
          card={dropCard}
          remaining={dropped.length}
          blockedReason={dropBlockedReason}
          onChange={handleDropChange}
          onConfirm={() => void handleDropConfirm()}
          onSkip={handleDropSkip}
        />
        {dragOver && <DropOverlay />}
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

export default App
