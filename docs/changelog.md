---
hide:
  - navigation
---

# changelog

All notable changes to owlette are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

For the full version management workflow, see [Version Management](internal/version-management.md).

---

## [2.9.0] - 2026-04-18

### added
- **Per-logical-volume disk IO monitoring** — agent now collects per-drive read/write throughput, IOPS, and busy% via WMI's `Win32_PerfFormattedData_PerfDisk_LogicalDisk`. Each drive (`C:`, `L:`, etc.) reports its own rates instead of one system-wide aggregate; selecting a different drive in the dashboard shows that drive's specific IO. New Firestore field `metrics.diskio` is keyed by volume id (mirrors `metrics.disks` shape). History samples carry per-volume entries under `sample.dios = [{i, rb, wb, bu}]`.
- **Disk IO surfaces on machine cards and list rows** — selected drive's read/write rates shown as stacked `r <rate>` (green) / `w <rate>` (orange) lines, hidden when idle. Auto-scales between B/s, KB/s, MB/s, GB/s. List-view disk cell widened to 160px with a 2-column layout (usage stats left, IO right).
- **Disk IO chart series in the metrics detail panel** — per-volume sub-toggles for read/write/busy% with volume-qualified labels (`C: read`, `L: busy`). Read/write render on the hidden axis (throughput); busy% shares the default 0-100% axis. Tooltip and stats grid both volume-qualified.
- **Friendly GPU names in the detail panel** — UUID stays as the chart-data key (stable, unique) while toggle labels, chart legend, stats grid, and tooltip all show "NVIDIA GeForce RTX 2080 Ti" via a lookup against the static profile.

### changed
- **Network cards now use arrow notation** (`↑ <rate>` / `↓ <rate>`) instead of `TX` / `RX` text on both card and list views — language-independent, more compact, and a cleaner visual rhythm with the new disk r/w letters.
- **Metric cell clicks SWAP the detail panel** instead of merging — clicking disk then GPU shows only GPU lines, not both. Click expansion still adds every per-device id (all disks, all GPUs, all NICs) so the panel shows all devices of the clicked type.
- **Toggles can deselect everything** — the "must keep at least one selected" guard is gone. Empty chart is a valid state; the stats grid hides cleanly.
- **Stats grid headers lowercased** (`avg` / `max` / `min`) for consistency with the rest of the panel's UI copy.

### fixed
- **MetricsDetailPanel chart now re-measures when the tab becomes visible** — Recharts' ResponsiveContainer would occasionally hold a stale width while the tab was backgrounded (rAF + ResizeObserver throttling), then render the plot area offset to the right with blank space on the left. A synthetic `window.resize` event on `visibilitychange → visible` forces all charts to re-measure.
- **Watchdog timeouts actually unblock the metrics loop** — both `_wmi_logical_disk_with_timeout` (disk IO) and `_disk_usage_with_timeout` (disk partitions) used `with ThreadPoolExecutor` whose `__exit__` calls `shutdown(wait=True)`, blocking forever on a hung WMI/network-mount worker. Switched both to manual lifecycle with `shutdown(wait=False, cancel_futures=True)` so a hung worker leaks instead of stalling.
- **NSSM runner crash on first metrics tick** — `MockService` in `owlette_runner.py` was missing four attributes that `OwletteService.__init__` defines (`_display_check_counter`, `_cached_display_hash`, `_shutting_down`, `_reboot_attempt_started_monotonic`). The display topology check at the top of every loop iteration crashed with `AttributeError`, causing NSSM to thrash-restart. Added the missing initializations plus two more (`_last_status_signature`, `_last_status_write_time`) for the status-throttle path.
- **NaN-guarded disk IO history extraction** — cloud function now uses `Number.isFinite()` checks before pushing IO entries to a sample. Prevents a poisoned NaN field (rare but possible from upstream perf-counter glitches) from causing Firestore to reject the entire history write.
- **Disk IO watchdog timeout 2s → 10s** — the old 2s budget skipped the perflib LogicalDisk stalls that occur when the BITS service flips state during Windows Update / Delivery Optimization polling, causing ~12% of metrics ticks to report empty disk IO. Empirical: 2s and 5s both still skipped (3.6-3.7 timeouts/hr, perfectly spaced ~16 min apart matching SCM 7040 BITS demand↔auto cycles); the perflib provider lock during a BITS state change consistently exceeds 5s. 10s captures them — verified at zero timeouts over 23 min observation post-fix. The metrics loop runs in its own thread (not the main service loop) so a 10s WMI call doesn't stall anything else. (A persistent-worker variant of the WMI call was tried first but reproducibly triggered RPC_E_WRONG_THREAD on every call after the first — the python `wmi` package binds proxies to the apartment that created them, and reusing a cached proxy from a long-lived thread is incompatible with how the package hands off to the COM runtime. The per-call pattern stays.)

---

## [2.8.1] - 2026-04-14

### added
- **Per-device metrics schema (v2)** — metrics now key cpus/disks/gpus/nics by stable device id instead of the old singular `cpu`/`disk`/`gpu` fields. Each machine publishes a `hardware/profile` subcollection document (schemaVersion 1) describing its physical devices; heartbeats reference those ids and include a `primary` pick per kind (selected by busyness with 5% hysteresis so the display doesn't flicker). Multi-GPU rigs, multi-disk setups, and multi-NIC hosts now render every device instead of collapsing to the first one.
- **Per-user device selection preferences** — dashboard list and card views remember which device each user wants to see per machine, persisted to `users/{uid}/devicePrefs/global` in Firestore (no localStorage). The list view shows a column-header dropdown when any visible machine has >1 of a kind; each row falls back to its own `primary` when the selection isn't present locally.
- **`deviceResolvers` utility** — `resolveDevice`, `shouldShowDeviceDropdown`, and `unionIds` helpers with unit tests; shared by list view, card view, and the metrics detail panel.
- **Metrics detail panel persistence** — selected metric tabs (and selected NIC, when relevant) now persist per machine via `userPreferences.graphTabs`, so refreshing or switching sites no longer resets your view.

### changed
- **Agent hardware profile is built on-device** (`hardware_profile.py`) with signature-hash change detection and a 5-minute rate-limit gate; only re-uploads when hardware actually changes. Gate stamps its timestamp *before* `build_profile()` so a persistent WMI/disk failure doesn't storm the heartbeat loop.
- **`shared_utils.get_system_metrics_with_config` retained its legacy snake_case shape** (`cpu`/`memory`/`disk`/`gpu`/`network`) for in-process consumers (`mcp_tools`, `report_issue`, tray GUI) while also carrying the camelCase keys the v2 uploader needs; `skip_gpu` is honored again to keep the tray GUI free of `nvidia-smi` console-window flashes.
- **WMI calls from the metrics thread now initialize COM** via `pythoncom.CoInitialize()` so per-socket CPU detection works on dual-socket workstations instead of silently falling through to the psutil fallback.
- **Legacy singular metrics fields are deleted on v2 upload** (`metrics.cpu`/`metrics.disk`/`metrics.gpu` → `DELETE_FIELD`) so doc size doesn't grow with both schemas side by side.

### fixed
- **Cloud `metricsHistory` function reads v2 per-device maps** (via `primary` + first-entry) with v1 fallback, so sparklines and threshold alerts keep working across the rollout window instead of flatlining the moment a v2 agent reports.
- **`shimLegacyMachine` no longer clobbers a real profile** during the mixed-version window when a v2 agent has uploaded its profile doc but its next metrics write is still legacy-shaped.
- **`hardware_profile._mac_for` return type** tightened to `Optional[str]`.

---

## [2.8.0] - 2026-04-12

### added
- **Per-machine Cortex kill switch** — operators can toggle Cortex off on a specific machine from the Cortex header (`CortexPowerToggle`). The agent reads the `cortexEnabled` flag before every poll and, when disabled, rejects pending messages with a clear error back to the web UI instead of executing tool calls. Firestore security rules were extended to allow dashboard writes to `cortexEnabled` without granting write access to agent-only fields (`online`, `lastHeartbeat`).
- **Profile photo upload/remove** — users can upload an avatar from account settings (`AccountSettingsDialog`). Photos are stored in Firebase Storage at `users/{uid}/avatar.jpg` and surfaced throughout the UI via the new `UserAvatar` component (Cortex chat bubbles, page header). New `storage.rules` grant each user read/write access to their own avatar path only.
- **Copy-message button in Cortex chat** — hover-revealed `CopyButton` on each chat bubble copies the full message text (cortex or user) to the clipboard.
- **Cortex suggested-question additions** and new `docs/dashboard/timezones.md` reference page.

### changed
- **Relicensed from AGPL-3.0 to FSL-1.1-Apache-2.0** (Functional Source License, Version 1.1, Apache 2.0 Future License). Self-hosting, internal use, non-commercial use, and professional services remain freely permitted; only competing commercial products or services are restricted. Each release automatically converts to Apache License 2.0 two years after it is made available. Copyright holder is The Experiential Company.
- Updated license references across web dashboard footers, landing page, terms page, OpenAPI spec, docs site footer, agent GUI, and repository README to reflect the new license.
- **`run_powershell` allow-list removed** — the first-token regex was security theater (a semicolon-prefixed `Get-Date; Remove-Item` bypassed it trivially) and caused constant false rejections on legitimate multi-statement scripts (`foreach`, `if`, `try`, `$var = ...`). Accountability now comes from the Firestore audit trail (`cortex-events` + site logs) and the `[MCP-AUDIT]` local log, which captures a 500-char preview of every script. `run_command` retains its binary allow-list.
- **Tier 3 audit previews expanded from 100 → 500 chars for script-bearing tools** (`run_powershell`, `execute_script`). One-line commands still truncate at 100. Multi-line PowerShell/Python bodies are now actually readable in the site log instead of showing only the first line.
- **`mcp_tool_call` exempted from the per-type command rate limit.** Cortex fires tool calls in parallel by design and is already authenticated + audit-logged per call; a 5-second throttle broke parallel queries. Other command types remain rate-limited.
- **`get_event_logs_filtered` wrapped in `try`/`catch`** — "no matching events" now returns `[]` cleanly instead of surfacing as a non-zero exit with empty stderr.
- **`sync-versions.js`** now updates the shields.io README version badge, the "Current" lines in `docs/internal/version-management.md`, and "Last Updated" date stamps automatically.

### fixed
- **`_get_agent_health` MCP tool** was calling a `HealthProbe()` API that no longer existed; rewired to the current `HealthProbe(config_path, api_base).run()` shape and now returns `status`, `error_code`, `error_message`, `checked_at`, and `checks` alongside version/hostname/uptime.

## [2.7.0] - 2026-04-11

### added
- **14 new MCP tools for Cortex** — purpose-built Tier 2 admin tools with validated parameters. Eliminates most fallbacks to `execute_script` for common sysadmin scenarios and produces cleaner chat UX (one green tool call instead of 2-4 red-then-green retries).
    - **`manage_process`** — kill / suspend / resume any OS process by name or glob pattern. Refuses to touch critical system processes (lsass, winlogon, csrss, etc.).
    - **`manage_windows_service`** — full services.msc parity: start / stop / restart / pause / continue / set_startup / set_recovery / get_details. `set_recovery` configures the auto-restart-on-crash safety net (first/second/subsequent failure actions, restart delay, reset counter). `get_details` returns status, startup type, binary path, dependencies, and recovery config in one call.
    - **`configure_gpu_tdr`** — set Windows GPU TDR (Timeout Detection and Recovery) registry values (TdrDelay, TdrDdiDelay). Critical for TouchDesigner/Unreal workloads with heavy shaders.
    - **`manage_windows_update`** — pause/resume + full scheduling: set_active_hours, set_scheduled_install, set_restart_deadline, set_feature_deferral, set_quality_deferral.
    - **`manage_notifications`** — suppress Windows toast notifications, enable Focus Assist (priority_only/alarms_only), disable notifications per-app. Essential for kiosks so Windows/Teams/Defender toasts don't appear on exhibit displays.
    - **`configure_power_plan`** — set power plan + disable sleep/hibernate/screen blanking. Required for every 24/7 unattended installation.
    - **`check_pending_reboot`** (Tier 1) — detect whether a reboot is pending and why (Windows Update, CBS, pending file renames, SCCM).
    - **`manage_scheduled_task`** — full taskschd.msc parity: list / enable / disable / delete / run_now / stop / create / get_details / get_history. `create` supports full trigger schema (boot/logon/once/daily/weekly/on_event/on_idle), run-as principals (SYSTEM/LOCAL_SERVICE/NETWORK_SERVICE), and settings (start_when_available, restart_count, execution_time_limit, multiple_instances, etc.).
    - **`network_reset`** — flush_dns / renew_ip / restart_adapter / reset_winsock.
    - **`registry_operation`** — allowlisted registry read / write / delete. Explicit allowlist of safe prefixes (Winlogon, GraphicsDrivers, WindowsUpdate, Notifications, Power, Services); SAM / SECURITY / Cryptography hives blocked.
    - **`clean_disk_space`** — clean temp / windows_temp / prefetch / recycle_bin / owlette_logs with age filter and dry-run mode.
    - **`get_event_logs_filtered`** — fast event log queries via `Get-WinEvent -FilterHashtable`. Orders of magnitude faster than the older `get_event_logs` when filtering by process, event ID, or time window.
    - **`manage_windows_feature`** — add / remove / list Windows Optional Features, Capabilities, or AppX packages. Removes OneDrive / Xbox Game Bar / Cortana / Teams consumer bloat during kiosk provisioning. Critical Windows features are blocklisted.
    - **`show_notification`** — display an on-screen toast or modal message (opposite of manage_notifications). Useful when a tech is physically nearby.
- **Background reboot-pending auto-alert** — agent checks for pending reboot every 15 min and emits a site event via the existing `/api/agent/alert` pipeline. Dashboard admins see "Reboot pending on [machine]" alerts; configured email/webhook alerts fire automatically. Idempotent — alerts once per pending-state transition.

### changed
- **Cortex CLAUDE.md** — new "Prefer Tier 2 tools over Tier 3" section with a mapping table. Cortex will now reach for purpose-built tools first and fall back to `execute_script` only for novel tasks.
- All new Tier 2 tools emit structured `[MCP-AUDIT]` log entries for security monitoring.
- `mcp_tools.py` gained `_CRITICAL_PROCESSES` blocklist and `_SAFE_REGISTRY_PREFIXES` allowlist as hardcoded safety helpers.

### security
- `manage_process` refuses to kill critical Windows processes (lsass, winlogon, csrss, services, etc.) and Owlette's own service — can't be bypassed via tool parameters.
- `registry_operation` has explicit allowlist + blocklist; hives like SAM and SECURITY are unreachable regardless of params.
- `manage_windows_feature` has a hardcoded blocklist of features Owlette itself depends on (NetFx4, WMI-*, PowerShell*, core networking).
- Scheduled task creation uses argument-list subprocess calls and PowerShell string escaping to prevent command injection via task names, programs, or arguments.

---

## [2.6.6] - 2026-04-11

### fixed
- **Screenshot capture restored** — the v2.6.5 `run_python` sandbox blocked internal screenshot callers (`mss`, `PIL`, `os` imports denied), breaking the dashboard screenshot panel, Cortex `capture_screenshot` tool, crash screenshots, and live view. `execute_in_user_session` now accepts a `trusted=True` flag for first-party callers that bypasses the sandbox; the LLM-facing `run_python` MCP tool remains sandboxed (`trusted=False` default).

---

## [2.6.5] - 2026-04-11

### security
- **MCP tool hardening** — `run_command` now uses `shell=False` with `shlex.split(posix=False)` to prevent shell injection via metacharacters (`&&`, `|`, `;`). Allowlist still validates the first token.
- **Python sandbox** — `run_python` restricts `__builtins__` (no `eval`, `exec`, `compile`, `os`, `subprocess`). Imports gated to safe stdlib modules only (math, json, re, datetime, etc.). `open()` and `getattr` are allowed for file I/O and introspection.
- **File I/O path validation** — `read_file` and `write_file` MCP tools validate paths against allowed directories (Owlette data, user profile, temp, configured process dirs). Blocks system directory access and path traversal.
- **PowerShell audit logging** — `execute_script`, `run_command`, `run_python`, `read_file`, `write_file` now emit `[MCP-AUDIT]` log entries for security monitoring.
- **Token exchange race fix** — registration code exchange uses two-phase pattern: validate → generate tokens → atomically mark used. Prevents burning codes on transient Firebase Auth failures.
- **Token refresh race fix** — refresh endpoint wrapped in Firestore transaction to prevent concurrent requests from creating inconsistent token state.
- **Command field allowlist** — `commands/send` API filters data fields per command type before writing to Firestore. Prevents field injection (e.g., overriding `timestamp` or `status`).
- **Error sanitization** — 60 API routes now use centralized `apiError()` helper that returns generic messages in production, hiding Firebase internals and stack traces.
- **Firestore rules hardened** — site creation requires `owner == auth.uid`, agent logs require `machineId == token.machine_id`, chat creation requires `userId == auth.uid` (with autonomous exception).
- **HSTS header** — `Strict-Transport-Security: max-age=31536000; includeSubDomains` added.
- **Redirect validation** — login and MFA pages validate redirect/return URLs (must be relative paths, blocks protocol-relative `//` redirects).
- **Cortex nonce dedup** — autonomous endpoint accepts optional `nonce` field to prevent replay attacks.
- **Deployment checksum validation** — API validates SHA-256 format when provided; agent already enforces verification.

### changed
- Updated `next` 16.2.1 → 16.2.3 (Server Component DoS fix)
- Updated `iron-session` 8.0.3 → 8.0.4 (cookie out-of-bounds char fix)
- Updated `cryptography` 41.0.7 → ≥44.0.0 (hygiene; CVE-2023-50782 not exploitable in Fernet-only usage)
- `-ExecutionPolicy Bypass` retained on `execute_script` (required for Group Policy–hardened kiosks)

---

## [2.6.4] - 2026-04-10

### added
- **Session state classifier** — new `session_state.py` module persists shutdown intent and last-alive timestamps across reboots. On startup, the agent classifies how the previous session ended and emits a warning event to the dashboard for anomalous shutdowns:
    - `external_reboot` — operator or Windows Update restarted the machine outside Owlette
    - `unexpected_reboot` — no shutdown signal detected (BSOD, power loss, hard reset)
    - `unexpected_service_restart` — agent process crashed or was killed (NSSM auto-restart)
    - Silent for Owlette-initiated reboots/shutdowns, version upgrades, and first runs
- Tooltips on event log action and detail text — truncated entries now show full text on hover (shadcn Tooltip, matching dashboard style)

### changed
- Reboot event log details cleaned up — human-readable info leads, entry UUID shortened to 8-char prefix for correlation (was full 36-char UUID)

---

## [2.6.3] - 2026-04-09

### fixed
- **CRITICAL**: scheduled reboot scheduler no longer fires entries that are more than 5 minutes late. A 5-minute "missed-fire grace window" silently skips any entry observed past its scheduled instant + 5 min, marks it as fired-for-the-day, and logs a `scheduled_reboot_missed` event to the dashboard. Previously, if the agent restarted (or a schedule entry was edited) AFTER the scheduled time, the agent would catastrophically fire the missed reboot the next time it observed the entry — hours late, with no warning, with no chance for the operator to cancel. This was the cause of an unintended reboot that destroyed days of in-progress rendering work on a dev machine
- Scheduled reboot scheduler no longer retries failed reboots. The previous 3-attempts-with-7-min-timeout retry loop is gone — a failed reboot is logged and dropped, never re-fired automatically
- Scheduled reboot scheduler now resolves entry times against the **machine's local timezone**, not the site timezone. A `14:00` entry on a Tokyo installation and a `14:00` entry on a New York installation in the same Owlette site now reboot at their respective local 14:00s, not synchronized to one shared timezone. The dashboard reboot-schedule editor was always timezone-agnostic — the agent was incorrectly applying the site timezone
- Tray icon "Exit" now actually stops the Owlette service. Previously it wrote a `tmp/shutdown.flag` file that the service detected and exited from, but NSSM's `AppExit Default Restart` immediately re-started the service, so Exit was a no-op the user couldn't see. Exit now triggers a UAC-elevated `net stop OwletteService` via the Service Control Manager, which is the only stop NSSM respects
- Latent `firestore_rest_client.set_document(merge=True)` bug fixed. When called without any `SERVER_TIMESTAMP` fields (e.g. every `set_machine_flag()` call), the function silently sent a PATCH without `updateMask.fieldPaths`, which the Firestore REST API treats as a full document REPLACEMENT — every field not in the request body was DELETED. This wiped `lastHeartbeat`, `online`, and `metrics` from the machine doc on every flag write, then the next `_upload_metrics` call (within ~1s) silently restored them. The bug had been latent in the codebase for an unknown length of time — only became visible when the new atomic startup flag-clear in this same release made the wipe gap large enough for the dashboard pill to flicker offline. Now correctly sends `updateMask` when `merge=True`
- Dashboard `MachineStatusPill` heartbeat parser hardened to handle every shape Firebase JS SDK v12 can return for a Timestamp field — `Timestamp` instance via `.toMillis()`, plain `{seconds, nanoseconds}` from cache rehydration, legacy `{_seconds, _nanoseconds}`, JS `Date`, plain number, ISO string. Previously, only the strict `Timestamp` instance shape was recognised; cache rehydrations dropped silently to `0`, which the staleness check then treated as "infinitely stale", flipping the dashboard pill offline
- Dashboard `rebootMachine()` and `shutdownMachine()` now write `configChangeFlag: true` alongside the optimistic countdown anchor. Without it, the firestore.rules `allow update` predicate rejected the write, so the optimistic countdown never appeared on the dashboard until the agent's own write came through (~5-10s later) — the perceived "the cancel button only appears right before the restart" bug

### changed
- Reboot countdown anchors `rebootScheduledAt` and `shutdownScheduledAt` are now Unix-seconds NUMBERS representing the TARGET reboot time (when the OS will actually restart). Previously they were Firestore server timestamps representing the START of a fixed 30-second countdown. The new semantic supports the new agent-side announce → 5-second pre-roll → 60-second OS countdown sequence, and the dashboard pill renders the countdown the moment the listener fires (no second round trip required)
- Agent reboot scheduler state file moved from `C:\ProgramData\Owlette\state\reboot_state.json` to `C:\ProgramData\Owlette\tmp\reboot_state.json`, alongside the existing `app_states.json` and `service_status.json`. The unused `state\` directory is removed entirely
- Tray Exit no longer writes `tmp/shutdown.flag`. The flag handler in the service main loop is also removed (it was dead code — see "fixed" above)

### added
- New `firebase_client.set_machine_flags(dict)` helper for atomic multi-field writes to the machine doc. Used by the new reboot announce path so the dashboard sees `rebootScheduledAt + rebooting + rebootSource + rebootCancellable + rebootEntryId` in a single listener tick instead of multiple intermediate states. Raises on failure (unlike the silent-log `set_machine_flag`) so callers can react

---

## [2.6.2] - 2026-04-08

### added
- Live cancel-reboot countdown on the dashboard — the status pill becomes a red pulsing `MM:SS` timer the moment a reboot or shutdown starts, anchored to a server-side `rebootScheduledAt` / `shutdownScheduledAt` timestamp so all viewers stay in sync and the countdown survives page refreshes
- Hover the countdown pill to reveal a "cancel" affordance; clicking it sends `cancel_reboot` and the pill returns to "online" once the agent confirms
- Context menu adapts during a pending reboot/shutdown — the reboot/shutdown items are replaced with a single red "cancel reboot" / "cancel shutdown" item, keeping the discoverable cancel path intact for users who don't notice the pill
- Final-5-seconds safety: pill becomes non-clickable and shows "rebooting…" because Windows `shutdown /a` is unreliable in the final phase
- Scheduled (cron) reboots now write the same countdown anchor, so they get the same live timer + cancel UX as manual reboots
- New shared `MachineStatusPill` component used by both list and card views — eliminates the duplicated status badge JSX and the now-redundant standalone cancel button in card view

### fixed
- Reboot/shutdown confirmation dialogs no longer claim "you can cancel during the countdown" without exposing any cancel UI — copy now reads "you'll have 30 seconds to cancel from the dashboard"
- `rebooting` and `shuttingDown` flags written by the agent are now actually read by the dashboard's Firestore listener — they were declared on the `Machine` interface but never propagated, so the existing "rebooting…" amber pill never displayed in production

---

## [2.6.1] - 2026-04-05

### added
- Batched process alert emails — crash alerts are queued for 2 minutes then grouped by site into a single digest email, preventing spam when multiple machines restart simultaneously
- New cron endpoint `/api/cron/process-alerts` drains the alert queue every 3 minutes and sends one digest email per site with a table of all affected machines/processes
- Digest email adapts: single alert uses the familiar single-process layout, multiple alerts show a grouped table

### fixed
- Owlette's built-in process restart (kill-and-relaunch for hung processes) no longer triggers false "process crashed" emails — writes KILLED status before terminating
- Scheduled and dashboard-initiated machine reboots/shutdowns no longer trigger crash alert emails — agent suppresses alerts during the shutdown window
- Removed unused `buildProcessAlertEmail` from alert route (moved to cron digest)

---

## [2.6.0] - 2026-04-04

### added
- Sentry error monitoring for both web dashboard and agent — captures unhandled exceptions with full stack traces, machine identity tags (hostname, site_id, project_id), and user context
- Agent Sentry events include structured machine context (hostname, site, version) for quick triage
- Sentry tunnel route on web to bypass ad-blockers
- `sentry` config section in agent config.json (disabled by default, preserved during Firestore sync)

### fixed
- Firestore config sync now preserves local-only keys (`firebase`, `sentry`) via `LOCAL_ONLY_KEYS`
- Sentry init added to NSSM runner (owlette_runner.py) — previously only in unused OwletteService.__init__
- Pre-existing stale test failures fixed: apiAuth NextRequest type, installer_utils terminate vs kill, shared_utils config/metrics API mismatches, removed deleted sanitize_process_name test

---

## [2.5.9] - 2026-04-03

### added
- Rich startup diagnostics logged on every service start: version banner (hostname, timezone, environment, Python version, Windows edition + build, install/data paths), system snapshot (CPU model + cores, RAM, disk free space, GPU name + VRAM, IP addresses), config summary (Firebase enabled, site ID, process count, Cortex status), startup phase timings (health probe, Firebase init, Firebase start), and a startup-complete summary block (version, total elapsed time, Firebase status, process count)

---

## [2.5.8] - 2026-04-03

### fixed
- `requireAdmin` middleware now accepts both API keys and Firebase ID tokens — previously only one auth method worked depending on route
- Firestore collection renamed from `apiKeys` to `api_keys` for naming consistency
- Cortex lowercase enforced across all user-facing text
- Phantom QR code references removed from device pairing flow
- Firestore timestamps standardised to `serverTimestamp()` across all writes
- Dead `presence?.online` fallback patterns removed from web reads
- Device code documents now deleted on consumption/expiry instead of being marked with a status field

---

## [2.5.7] - 2026-04-02

### added
- FAQ section on landing page
- Pricing section on landing page

### fixed
- Update log event no longer writes version string into the `level` field
- Update log messages lowercased; version strings prefixed with `v`
- "Updating owlette" label shown in dashboard while agent update is in progress
- Landing page explore link spacing polished

---

## [2.5.6] - 2026-04-02

### added
- API and Webhooks promoted to top-level nav section in docs

### fixed
- `presence?.online` dead fallback patterns removed from web dashboard reads

---

## [2.5.5] - 2026-04-02

### added
- Per-user alert emails — each user receives alerts for their own assigned machines
- Timezone labels in email alerts
- Centered unsubscribe link in alert emails

### fixed
- Missing Firestore indexes added; `claude-agent-sdk` dependency pinned

---

## [2.5.4] - 2026-04-01

### added
- **Process scheduling UX overhaul** — redesigned schedule editor with overnight schedule support (e.g. 22:00–06:00 spanning midnight)

### fixed
- Site members can now access machine controls without requiring admin role

---

## [2.5.3] - 2026-04-01

### fixed
- **Auto-update now reliably replaces Python files** — replaced deprecated WMIC `call terminate` with PowerShell `Stop-Process -Force` in the installer's `InitializeSetup()` phase. WMIC was silently failing to kill Python processes before file overwrite, causing Inno Setup to schedule locked DLLs for next-reboot replacement (which never comes during auto-update). Two-pass kill with verification ensures all handles are released before file copy begins.

---

## [2.5.2] - 2026-03-31

### changed
- Version bump

---

## [2.5.1] - 2026-03-31

### added
- Agent longevity hardening for 24/7 uptime — fixed resource leaks, unbounded queue growth, and error handling across all background threads
- Windows console event signal handling (`CTRL_SHUTDOWN_EVENT` etc.) in the agent runner
- Version number logged at service startup

### fixed
- Dashboard machine online/offline status delay reduced from ~27s to ~4s
- Slow command worker thread must start after `self.running = True` (previously caused worker to exit immediately)
- Killed processes no longer trigger crash detection and relaunch
- Parallel install support for Cortex `deploy_software` — existing registry keys hidden from installer to prevent unintended removal of previous versions
- Cortex now requires explicit user confirmation before calling `deploy_software`
- `install.bat` service detection switched to registry query — `nssm status` returned non-zero for stopped services, causing upgrade installs to skip removal and fail on re-registration

### performance
- Landing page Lighthouse score improved from 69 to 89

---

## [2.4.4] - 2026-03-31

### added
- **Cortex `deploy_software` tool** — AI-driven software deployment with full pipeline tracking (download, silent install, verify, Deployments page visibility). Server-side tool with user confirmation required
- **Cortex `get_system_presets` tool** — Retrieves admin-configured software presets (installer URLs, silent flags, verification paths) for use with `deploy_software`
- **12h/24h time format preference** — User preference persisted to Firestore, applied across schedule editor, time pickers, and dashboard
- `listen_to_document` returns a `wake_event` for instant polling on Firestore writes

### fixed
- `deploy_software` overrides `/DIR` flag to match the target version install path
- Bidirectional config sync between agent and Firestore
- Network metrics flickering on dashboard
- Process list not detecting running processes; added Deployments link
- Cortex sidebar categories sorted by recency, batch categorize fixed
- Schedule editor time picker opens upward when near bottom of viewport
- `timeFormat` preference not persisting due to missing equality check

---

## [2.4.2] - 2026-03-27

### added
- **Feedback / Bug Reporting** — Report bugs from the web dashboard and the agent GUI (system tray → "Report Issue"), with log attachments and direct Firestore submission
- **Branded email templates** — Dark-theme HTML emails with shared layout system (header, footer, logo, site name in all transactional emails)
- **Landing page overhaul** — New hero with eye ignition animation, Blade Runner easter egg, rotating word, typewriter text, interactive background, use case and value prop sections, demo mode
- **Demo mode** — Full dashboard preview with simulated data, no login required
- SEO overhaul — new OG image, lowercase brand voice, sitemap, robots.txt, proper metadata
- File path, arguments, and PID displayed on process rows in the dashboard
- Download link in landing page nav; `/download` redirect route

### fixed
- Agent Bearer token auth in bug-report API route
- Email template: logo URL fallback, auto-link color, footer links, Gmail clipping
- Landing page layout: 4K centering, mobile accordion, hero vertical alignment, subheadline jitter

---

## [2.4.1] - 2026-03-26

### changed
- **Agent pairing replaces browser OAuth** — Agents now authenticate via device code flow. The installer displays a 3-word pairing phrase, auto-opens the pairing page in a browser, or users enter the phrase on the dashboard
- Installer publisher, URLs, and fallback version updated

### fixed
- Installer pairing UX — auto-opens browser, improved colors, handles failure gracefully
- Rate limits increased; pause added on pairing failure
- Dashboard button and status badge hover states

### removed
- Browser-based OAuth flow (replaced by device code pairing)

---

## [2.4.0] - 2026-03-25

### added
- **Network Monitoring Dashboard** — Per-NIC throughput charts with historical data (upload/download MB/s per adapter)
- **Agent GPU Process Monitoring** — Per-process VRAM usage via Windows Performance Counters (cross-vendor: NVIDIA, AMD, Intel)
- **Cortex `execute_script` tool** — Unrestricted PowerShell execution on the remote machine (Tier 3, requires confirmation)
- **Screenshot Vision Analysis** — Cortex can analyze captured screenshots and provide behavioral guidance
- **Cortex Chat Improvements** — Markdown rendering, conversation categorization, process context awareness
- **Live View** — Real-time screenshot stream modal in the dashboard
- **Reboot Scheduling** — Schedule recurring reboots with cron-style configuration
- **Threshold Alerts** — Configurable alerts when CPU, memory, or disk usage exceeds thresholds
- **Webhook Platform Formatting** — Slack, Teams, and Discord formatted payloads for webhook notifications
- **OpenAPI Documentation** — Auto-generated API docs via Scalar at `/docs/api`
- **Admin Tools API** — REST endpoints for all Cortex tools, usable by external integrations
- **Logs Improvements** — Infinite scroll, date range filters, auth re-render optimization
- React Markdown rendering with GFM support in Cortex chat

### fixed
- Screenshot max width increased to 8K; lower JPEG quality for reduced payload size
- Cortex language and tone improvements

---

## [2.3.1] - 2026-03-24

### changed
- Version bump for documentation audit and accuracy pass

---

## [2.3.0] - 2026-03-22

### added
- **Cortex AI Chat** — AI-powered chat interface with 29 specialized tools across three tiers for machine management via natural language
  - Tier 1 (read-only): system info, process lists, logs, metrics, network, disk
  - Tier 2 (process management): restart, kill, start, set launch mode, screenshot
  - Tier 3 (privileged): run commands/scripts, read/write files, reboot/shutdown
  - Autonomous mode: AI auto-investigates process crashes with configurable directives
  - Escalation system: emails admins when Cortex can't resolve an issue
  - Per-user and per-site LLM key management (encrypted at rest)
- **Passkey Authentication (WebAuthn)** — Passwordless login using biometrics or device PIN
  - Discoverable credentials (no email needed to start login)
  - Passkey login skips 2FA entirely (passkey IS the second factor)
  - Clone detection via signature counter validation
  - Management UI: list, rename, and delete registered passkeys
- **Webhook Notifications** — Configurable webhooks for process events, machine status changes, and deployment updates
- **Process Scheduling** — Schedule processes to run during specific time windows with launch modes (off, always, scheduled)
  - Schedule presets for reuse across processes
  - Admin schedule management page
- **Screenshot Capture** — Remote desktop screenshots with multi-monitor support
- **Health Probes** — Agent-side health monitoring with configurable checks
- **Server-Side Deployment Status** — Firebase Cloud Functions for automatic deployment status tracking
  - Firestore trigger updates deployment status on command completion
  - Scheduled sweeper marks stale deployments as failed (15 min pending, 30 min active)
- **Software Inventory** — Agent reports installed software to Firestore
- **Admin Webhook Management** — Dashboard page for configuring site webhooks
- **Admin Schedule Presets** — Dashboard page for managing schedule presets
- **MkDocs Documentation** — Complete documentation rewrite with MkDocs Material theme

### changed
- Agent monitoring loop interval reduced from 10s to 5s
- Deployment system now uses Firebase Cloud Functions for status aggregation
- Process launch mode replaces simple autolaunch toggle (`set_launch_mode` replaces `toggle_autolaunch`)

### removed
- `owlette_updater.py` — self-update logic moved into main service command handler

---

## [2.1.8] - 2026-03-15

### added
- Remote reboot/shutdown commands with dashboard UI
- Process crash email alerts
- Installer setup logging enabled by default

### fixed
- `useSites` hook fetches assigned sites individually instead of collection query
- Setup page fetches assigned sites individually instead of collection query

---

## [2.0.49] - 2025-11-28

### fixed
- **VBS Cleanup Race Condition** — VBS wrapper files for hidden process launches are now cleaned up in a background thread after 10s delay, preventing "file in use" errors
- **Reduced Log Noise** — GUI config change detection logs moved from INFO to DEBUG; verbose tray status logging removed

---

## [2.0.48] - 2025-11-26

### fixed
- **Windows Defender False Positive** — Installer now adds Defender exclusion for owlette directory (WinRing0 driver flagged as `VulnerableDriver:WinNT/Winring0`). Exclusion removed on uninstall.
- **Join Site Performance** — Fixed extremely slow "Join Site" operation (2+ minutes to instant) by removing redundant Firebase client initialization from GUI
- **Silent Browser Launch** — Changed from `webbrowser.open()` to `os.startfile()` to prevent flashing command prompt windows during OAuth flow

---

## [2.0.47] - 2025-11-24

### fixed
- **Token Encryption Key Stability** — Changed encryption key derivation from `uuid.getnode()` (MAC address) to Windows `MachineGuid`. MAC address can return different values after reboot; `MachineGuid` is stable. Resolves "Agent not authenticated" errors after restart.

---

## [2.0.46] - 2025-11-19

### added
- **Email Testing Page** — New admin-only page at `/admin/test-email` for testing email notifications, templates, and delivery
- **Update Panel Layout** — Improved spacing and organization for machine update dialog

---

## [2.0.44] - 2025-11-13

### added
- **Config & Logs Buttons** — Quick access buttons in GUI footer to open config.json and logs folder
- **Custom Messagebox** — Improved text wrapping (92% width), compact layout, dark theme matching
- **Firebase Reconnection Auto-Detection** — Service detects when Firebase is re-enabled and automatically restarts the client

### changed
- **Unified Site Management** — Join/Leave Site consolidated into single dynamic button
- **Increased Deployment Timeout** — Extended from 20 to 40 minutes for large installers
- **Force Close on Uninstall** — Inno Setup uninstalls now automatically close running applications

### fixed
- **Firebase Client Reference Errors** — Fixed incorrect global variable usage in uninstall handler
- **Firebase Client Not Restarting** — Service now detects enable/disable transitions and reinitializes

---

## [2.0.29] - 2025-11-12

### fixed
- **Config Version for New Installs** — Fixed hardcoded version in configure_site.py; new installs now use correct `CONFIG_VERSION` constant

---

## [2.0.28] - 2025-11-12

### added
- **Environment Configuration** — New `environment` setting in config.json (production vs development)

### fixed
- **Tray Icon Launch Failure** — Added `get_python_exe_path()` helper to locate bundled Python interpreter
- **Incorrect Server URL** — "Join Site" now correctly defaults to production URL
- **Port Conflict on Retry** — Enabled `allow_reuse_address` on OAuth callback server

---

## [2.0.27] - 2025-11-11

### fixed
- **Software Inventory Sync Error** — Fixed `NameError` in post-installation inventory sync
- **Real-Time Deployment Status** — Fixed deployment status staying on "downloading" until manual refresh; now transitions in real-time

---

## [2.0.26] - 2025-11-11

### added
- **Process Launch via Task Scheduler** — Complete rewrite using `schtasks` for service restart resilience
- **Enhanced Event Logging** — Agent lifecycle events, process crash detection, GUI kill tracking

### fixed
- **Agent Stopped Logging** — Implemented restart flag mechanism for graceful shutdown event logging
- **Process Crash False Positives** — Crash events no longer logged for manually killed processes

---

## [2.0.15] - 2025-11-11

### added
- **Event Logs Page** — Dedicated page for monitoring process events with filtering, pagination, and color-coded severity
- **Hidden Process Launch** — VBScript wrapper for truly invisible console application launches
- **Event Logging to Firestore** — Automatic logging of process starts, kills, crashes, and command executions

---

## [2.0.0] - 2025-01-31

### major release — cloud-connected architecture

Version 2.0.0 transforms owlette from a standalone Windows process manager to a cloud-connected system.

#### added
- **Next.js Web Dashboard** — Remote monitoring and control from any browser
- **Firebase/Firestore Backend** — Real-time bidirectional data sync
- **Remote Software Deployment** — Silent installation across multiple machines
- **Deployment Templates** — Save and reuse installer configurations
- **PID Recovery** — Reconnect to existing processes after service restart
- **Multi-Site Management** — Organize machines by location

#### changed
- **Monorepo Structure** — Unified `agent/` and `web/` directories
- **Firebase as Primary Backend** — Gmail/Slack marked as legacy
- **Configuration Schema** — Updated to v1.3.0 with Firebase settings

#### deprecated
- Gmail and Slack notifications (replaced by web dashboard alerts)

---

## [0.4.2b] - legacy

### standalone architecture

The original owlette — a standalone Windows service with local configuration.

- Windows service process monitoring with auto-restart
- System tray icon and GUI configuration
- Gmail API and Slack API notifications
- Local JSON configuration
- Process priority and visibility control

---

## migration guide: v0.4.2b to v2.0.0

| v0.4.2b feature | v2.0.0 equivalent |
|-----------------|-------------------|
| Gmail notifications | Web dashboard alerts + email via Resend |
| Slack notifications | Web dashboard alerts |
| Local GUI only | GUI + Web dashboard |
| Manual configuration | GUI or web-based config |
| Single machine | Multi-machine, multi-site |
| N/A | Remote deployment |
| N/A | Project distribution |
| N/A | Cortex AI chat |
