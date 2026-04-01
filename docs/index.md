---
hide:
  - navigation
---

# owlette

### Always Watching

owlette is a cloud-connected Windows process management and remote deployment system. Built for managing TouchDesigner installations, digital signage, kiosks, and media servers — it keeps your machines running and your processes alive, from anywhere.

owlette is three things working together:

<div class="grid cards" markdown>

-   :material-monitor-dashboard:{ .lg .middle } **Agent** — Process Guardian

    ---

    A lightweight Windows service that monitors your processes every 5 seconds, auto-restarts crashed applications, collects system metrics, and syncs everything to the cloud. Configure locally via GUI or remotely from the web.

    [:octicons-arrow-right-24: Learn about the agent](agent/index.md)

-   :material-web:{ .lg .middle } **Dashboard** — Remote Control

    ---

    A real-time web dashboard for monitoring machines, managing processes, deploying software, and distributing project files across your entire fleet. Built with Next.js and Firebase for instant updates.

    [:octicons-arrow-right-24: Explore the dashboard](dashboard/index.md)

-   :material-robot:{ .lg .middle } **Cortex** — AI Assistant

    ---

    An AI-powered chat interface that connects to your machines through natural language. Query system info, restart processes, capture screenshots, and troubleshoot issues — all through conversation with 29 specialized tools. Autonomous mode auto-investigates crashes without human intervention.

    [:octicons-arrow-right-24: Meet Cortex](dashboard/cortex.md)

</div>

---

## What You Can Do

| | Capability | Description |
|---|-----------|-------------|
| :material-restart: | **Auto-restart crashed processes** | Agent detects crashes within 10 seconds and restarts applications automatically |
| :material-monitor: | **Monitor machines remotely** | Real-time CPU, memory, disk, and GPU metrics from any browser |
| :material-download: | **Deploy software remotely** | Push installers to multiple machines with silent installation |
| :material-folder-sync: | **Distribute project files** | Sync ZIP archives across your fleet using your own file hosting |
| :material-chat: | **Talk to your machines** | Use Cortex AI to query, control, and troubleshoot via natural language |
| :material-shield-account: | **Manage users and roles** | Admin panel for user management, site assignment, and access control |
| :material-bell: | **Get alerted** | Email and webhook notifications when machines go offline or processes crash |
| :material-camera: | **Capture screenshots** | Take remote screenshots of machine displays from the dashboard or Cortex |
| :material-update: | **Update agents remotely** | Push agent updates to all machines from the dashboard |

---

## Key Features

| | Feature | Description |
|---|---------|-------------|
| :material-sync: | **Real-Time Sync** | Bidirectional Firestore sync between agents, dashboard, and GUI — changes propagate in ~1-2 seconds |
| :material-shield-lock: | **OAuth Security** | Two-token agent authentication with automatic refresh, encrypted storage, and machine-scoped access |
| :material-office-building: | **Multi-Site** | Organize machines into sites (locations, departments) with per-user access control |
| :material-wifi-off: | **Offline Resilient** | Agents continue monitoring locally when disconnected, auto-sync when reconnected |
| :material-chart-line: | **Historical Metrics** | 24-hour, 7-day, and 30-day metric charts with sparkline previews |
| :material-cog: | **System Presets** | Save and apply process configurations across machines |
| :material-calendar-clock: | **Process Scheduling** | Schedule processes to run during specific time windows (days + hours) |
| :material-key: | **Passkey Login** | Passwordless authentication via biometrics or device PIN (WebAuthn/FIDO2) |
| :material-two-factor-authentication: | **2FA Support** | TOTP-based two-factor authentication with backup codes |
| :material-webhook: | **Webhooks** | Send event notifications to external systems via HTTPS webhooks with HMAC signing |

---

## Requirements

- **Agent**: Windows 10 or later
- **Dashboard**: Any modern browser (deployed to Railway or self-hosted)
- **Backend**: Firebase project (Firestore + Authentication)
- **Optional**: Resend account for email alerts

---

## Quick Start

1. **Create an account** at [owlette.app](https://owlette.app)
2. **Create a site** — Organize your machines by location or project
3. **Install the agent** — Download the installer and run it on your Windows machines
4. **Add processes** — Tell owlette which applications to monitor
5. **Start managing** — Your machines appear in the dashboard within seconds

[:octicons-arrow-right-24: Full getting started guide](getting-started.md)

!!! info "Want to self-host?"
    You can run your own owlette instance with your own Firebase project. See the [Self-Hosting](setup/index.md) guide.
