# Changelog

All notable changes to Owlette are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

For the full version management workflow, see [Version Management](internal/version-management.md).

---

## [2.3.1] - 2026-03-24

### Changed
- Version bump for documentation audit and accuracy pass

---

## [2.3.0] - 2026-03-22

### Added
- **Cortex AI Chat** — AI-powered chat interface with 24 specialized tools across three tiers for machine management via natural language
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

### Changed
- Agent monitoring loop interval reduced from 10s to 5s
- Deployment system now uses Firebase Cloud Functions for status aggregation
- Process launch mode replaces simple autolaunch toggle (`set_launch_mode` replaces `toggle_autolaunch`)

### Removed
- `owlette_updater.py` — self-update logic moved into main service command handler

---

## [2.1.8] - 2026-03-15

### Added
- Remote reboot/shutdown commands with dashboard UI
- Process crash email alerts
- Installer setup logging enabled by default

### Fixed
- `useSites` hook fetches assigned sites individually instead of collection query
- Setup page fetches assigned sites individually instead of collection query

---

## [2.0.49] - 2025-11-28

### Fixed
- **VBS Cleanup Race Condition** — VBS wrapper files for hidden process launches are now cleaned up in a background thread after 10s delay, preventing "file in use" errors
- **Reduced Log Noise** — GUI config change detection logs moved from INFO to DEBUG; verbose tray status logging removed

---

## [2.0.48] - 2025-11-26

### Fixed
- **Windows Defender False Positive** — Installer now adds Defender exclusion for Owlette directory (WinRing0 driver flagged as `VulnerableDriver:WinNT/Winring0`). Exclusion removed on uninstall.
- **Join Site Performance** — Fixed extremely slow "Join Site" operation (2+ minutes to instant) by removing redundant Firebase client initialization from GUI
- **Silent Browser Launch** — Changed from `webbrowser.open()` to `os.startfile()` to prevent flashing command prompt windows during OAuth flow

---

## [2.0.47] - 2025-11-24

### Fixed
- **Token Encryption Key Stability** — Changed encryption key derivation from `uuid.getnode()` (MAC address) to Windows `MachineGuid`. MAC address can return different values after reboot; `MachineGuid` is stable. Resolves "Agent not authenticated" errors after restart.

---

## [2.0.46] - 2025-11-19

### Added
- **Email Testing Page** — New admin-only page at `/admin/test-email` for testing email notifications, templates, and delivery
- **Update Panel Layout** — Improved spacing and organization for machine update dialog

---

## [2.0.44] - 2025-11-13

### Added
- **Config & Logs Buttons** — Quick access buttons in GUI footer to open config.json and logs folder
- **Custom Messagebox** — Improved text wrapping (92% width), compact layout, dark theme matching
- **Firebase Reconnection Auto-Detection** — Service detects when Firebase is re-enabled and automatically restarts the client

### Changed
- **Unified Site Management** — Join/Leave Site consolidated into single dynamic button
- **Increased Deployment Timeout** — Extended from 20 to 40 minutes for large installers
- **Force Close on Uninstall** — Inno Setup uninstalls now automatically close running applications

### Fixed
- **Firebase Client Reference Errors** — Fixed incorrect global variable usage in uninstall handler
- **Firebase Client Not Restarting** — Service now detects enable/disable transitions and reinitializes

---

## [2.0.29] - 2025-11-12

### Fixed
- **Config Version for New Installs** — Fixed hardcoded version in configure_site.py; new installs now use correct `CONFIG_VERSION` constant

---

## [2.0.28] - 2025-11-12

### Added
- **Environment Configuration** — New `environment` setting in config.json (production vs development)

### Fixed
- **Tray Icon Launch Failure** — Added `get_python_exe_path()` helper to locate bundled Python interpreter
- **Incorrect Server URL** — "Join Site" now correctly defaults to production URL
- **Port Conflict on Retry** — Enabled `allow_reuse_address` on OAuth callback server

---

## [2.0.27] - 2025-11-11

### Fixed
- **Software Inventory Sync Error** — Fixed `NameError` in post-installation inventory sync
- **Real-Time Deployment Status** — Fixed deployment status staying on "downloading" until manual refresh; now transitions in real-time

---

## [2.0.26] - 2025-11-11

### Added
- **Process Launch via Task Scheduler** — Complete rewrite using `schtasks` for service restart resilience
- **Enhanced Event Logging** — Agent lifecycle events, process crash detection, GUI kill tracking

### Fixed
- **Agent Stopped Logging** — Implemented restart flag mechanism for graceful shutdown event logging
- **Process Crash False Positives** — Crash events no longer logged for manually killed processes

---

## [2.0.15] - 2025-11-11

### Added
- **Event Logs Page** — Dedicated page for monitoring process events with filtering, pagination, and color-coded severity
- **Hidden Process Launch** — VBScript wrapper for truly invisible console application launches
- **Event Logging to Firestore** — Automatic logging of process starts, kills, crashes, and command executions

---

## [2.0.0] - 2025-01-31

### Major Release — Cloud-Connected Architecture

Version 2.0.0 transforms Owlette from a standalone Windows process manager to a cloud-connected system.

#### Added
- **Next.js Web Dashboard** — Remote monitoring and control from any browser
- **Firebase/Firestore Backend** — Real-time bidirectional data sync
- **Remote Software Deployment** — Silent installation across multiple machines
- **Deployment Templates** — Save and reuse installer configurations
- **PID Recovery** — Reconnect to existing processes after service restart
- **Multi-Site Management** — Organize machines by location

#### Changed
- **Monorepo Structure** — Unified `agent/` and `web/` directories
- **Firebase as Primary Backend** — Gmail/Slack marked as legacy
- **Configuration Schema** — Updated to v1.3.0 with Firebase settings

#### Deprecated
- Gmail and Slack notifications (replaced by web dashboard alerts)

---

## [0.4.2b] - Legacy

### Standalone Architecture

The original Owlette — a standalone Windows service with local configuration.

- Windows service process monitoring with auto-restart
- System tray icon and GUI configuration
- Gmail API and Slack API notifications
- Local JSON configuration
- Process priority and visibility control

---

## Migration Guide: v0.4.2b to v2.0.0

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
