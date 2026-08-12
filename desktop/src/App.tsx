import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog'
import { OwletteEye } from '@/components/landing/OwletteEye'
import { ProcessDetail } from '@/components/ProcessDetail'
import { ProcessList, type ProcessAction } from '@/components/ProcessList'
import { StatusFooter } from '@/components/StatusFooter'
import { WindowControls } from '@/components/WindowControls'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStates } from '@/hooks/useAppStates'
import { useOwletteConfig } from '@/hooks/useOwletteConfig'
import { useServiceHealth } from '@/hooks/useServiceHealth'
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
  setVisibility,
  updateProcess,
  type LaunchMode,
  type OwletteConfig,
  type Priority,
  type ProcessEntry,
  type ProcessForm,
  type Visibility,
} from '@/lib/owletteConfig'
import { livePidForProcess, statusForProcess } from '@/lib/processStatus'
import { NoLiveInstanceError, stopProcess, type StopMode } from '@/lib/processControl'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

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
          className="flex h-10 shrink-0 select-none items-center gap-2.5 border-b pl-4"
        >
          <OwletteEye size={18} className="pointer-events-none" />
          <span className="pointer-events-none text-sm font-medium tracking-tight">owlette</span>
          <span data-tauri-drag-region className="h-full flex-1" />
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
          <aside className="w-72 shrink-0 border-r">
            <ProcessList
              processes={processes}
              states={appStates.states}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={() => void handleAdd()}
              onAction={handleAction}
              onReorder={handleReorder}
            />
          </aside>

          <section className="min-w-0 flex-1">
            {selected ? (
              <ProcessDetail
                key={selected.id}
                process={selected}
                status={statusForProcess(appStates.states, selected.id)}
                onSave={handleSaveForm}
                onLaunchMode={handleLaunchMode}
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
          starting={health.starting}
          onStart={() => void health.start()}
        />

        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

export default App
