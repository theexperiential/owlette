# getting started

Get your first machine monitored in under 5 minutes.

---

## step 1: create an account

1. Go to [owlette.app](https://owlette.app)
2. Click **Register** and create an account with email/password or Google sign-in
3. Optionally set up **two-factor authentication** or register a **passkey** for fast biometric login

---

## step 2: create a site

Sites organize your machines — think of them as locations, departments, or projects.

1. Click **"Create Site"** in the dashboard
2. Enter a **Site Name** (e.g., "NYC Gallery", "Main Office")
3. Enter a **Site ID** (e.g., `nyc-gallery`) — this is permanent
4. Click **Create**

---

## step 3: install the agent

### download

1. Click the **download button** in the dashboard header to get the latest agent installer
2. Transfer the installer to the Windows machine you want to monitor

### install & connect

1. Run the installer **as Administrator** on your target machine
2. Follow the setup wizard
3. A console window displays a **pairing phrase** (3 random words) and your browser opens automatically
4. Select a site and click **"Authorize"**
5. The agent receives credentials and connects — done

!!! tip "Bulk deployment"
    For deploying to many machines, use the `/ADD=` flag with a pre-authorized phrase from the dashboard. See [Installation → Silent Install](agent/installation.md#method-2-silent-install-with-add-bulk-deployment).

---

## step 4: verify

Within 30 seconds of installation, your machine should appear in the dashboard:

| Check | What to Look For |
|-------|-----------------|
| **Machine visible** | Machine card appears in your site with a green "Online" indicator |
| **Metrics flowing** | CPU, memory, disk percentages updating |
| **System tray** | Owl icon visible in the Windows notification area |

---

## step 5: add processes to monitor

Now that your machine is connected, tell owlette which applications to watch:

1. Click on your machine in the dashboard
2. Click **"Add Process"**
3. Enter the **executable path** (e.g., `C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe`)
4. Give it a **name** (e.g., "TouchDesigner")
5. Enable **Autolaunch** to auto-start and auto-restart on crash
6. Click **Save**

The agent immediately begins monitoring the process. If it crashes, owlette restarts it within 10 seconds.

---

## what's next?

You're up and running. Here's what else you can do:

- [**Configure process settings**](dashboard/process-management.md) — Priority, visibility, launch delay, crash limits
- [**Deploy software remotely**](dashboard/deployments.md) — Push installers to machines without physical access
- [**Distribute project files**](dashboard/project-distribution.md) — Sync ZIP archives across your fleet
- [**Chat with your machines**](dashboard/cortex.md) — Use Cortex AI to query and control machines via natural language
- [**Set up email alerts**](dashboard/admin/email-alerts.md) — Get notified when machines go offline or processes crash
- [**Add more machines**](agent/installation.md) — Scale out to your full fleet
- [**Invite team members**](dashboard/admin/user-management.md) — Add users with role-based site access

---

## need help?

- Check the [Troubleshooting](troubleshooting.md) guide for common issues
- Review [Agent Troubleshooting](agent/troubleshooting.md) for agent-specific problems
- Open an issue on [GitHub](https://github.com/theexperiential/owlette/issues)
- Email us at [support@owlette.app](mailto:support@owlette.app)
