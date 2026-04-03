---
hide:
  - navigation
---

# owlette

### attention is all you need

owlette is a cloud-connected Windows process management and remote deployment system. Built for managing TouchDesigner installations, digital signage, kiosks, and media servers — it keeps your machines running and your processes alive, from anywhere.

owlette is three things working together:

<div class="grid cards" markdown>

-   :material-monitor-dashboard:{ .lg .middle } **agent** — process guardian

    ---

    A lightweight Windows service that monitors your processes every 5 seconds, auto-restarts crashed applications, collects system metrics, and syncs everything to the cloud. Configure locally via GUI or remotely from the web.

    [:octicons-arrow-right-24: learn about the agent](agent/index.md)

-   :material-web:{ .lg .middle } **dashboard** — remote control

    ---

    A real-time web dashboard for monitoring machines, managing processes, deploying software, and distributing project files across your entire fleet. Built with Next.js and Firebase for instant updates.

    [:octicons-arrow-right-24: explore the dashboard](dashboard/index.md)

-   :material-brain:{ .lg .middle } **cortex** — ai assistant

    ---

    An AI-powered chat interface that connects to your machines through natural language. Query system info, restart processes, capture screenshots, and troubleshoot issues — all through conversation with 29 specialized tools. Autonomous mode auto-investigates crashes without human intervention.

    [:octicons-arrow-right-24: meet cortex](dashboard/cortex.md)

</div>

---

## what you can do

| | capability | description |
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

## key features

| | feature | description |
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

## requirements

- **Agent**: Windows 10 or later
- **Dashboard**: Any modern browser (deployed to Railway or self-hosted)
- **Backend**: Firebase project (Firestore + Authentication)
- **Optional**: Resend account for email alerts

---

## quick start

1. **Create an account** at [owlette.app](https://owlette.app)
2. **Create a site** — Organize your machines by location or project
3. **Install the agent** — Download the installer and run it on your Windows machines
4. **Add processes** — Tell owlette which applications to monitor
5. **Start managing** — Your machines appear in the dashboard within seconds

[:octicons-arrow-right-24: full getting started guide](getting-started.md)

!!! info "Want to self-host?"
    You can run your own owlette instance with your own Firebase project. See the [Self-Hosting](setup/index.md) guide.

---

## support

- Email us at [support@owlette.app](mailto:support@owlette.app)
- File a bug or feature request on [GitHub](https://github.com/theexperiential/owlette/issues)
