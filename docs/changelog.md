# changelog

All notable changes to owlette are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

For the full version management workflow, see [Version Management](internal/version-management.md).

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
- **Agent pairing replaces browser OAuth** — Agents now authenticate via QR code / device code flow. No browser window is opened on the target machine; users scan a QR code or enter a 3-word phrase in the dashboard
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

| v0.4.2b Feature | v2.0.0 Equivalent |
|-----------------|-------------------|
| Gmail notifications | Web dashboard alerts + email via Resend |
| Slack notifications | Web dashboard alerts |
| Local GUI only | GUI + Web dashboard |
| Manual configuration | GUI or web-based config |
| Single machine | Multi-machine, multi-site |
| N/A | Remote deployment |
| N/A | Project distribution |
| N/A | Cortex AI chat |
