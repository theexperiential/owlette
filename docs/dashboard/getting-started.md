# dashboard getting started

This guide walks you through your first experience with the owlette dashboard — from login to seeing your first machine.

---

## first login

### email/password

1. Navigate to your dashboard URL (e.g., `https://owlette.app` or `https://dev.owlette.app`)
2. Click **Register** and create an account
3. After registration, you're automatically logged in

### google oauth

1. Click **"Sign in with Google"** on the login page
2. Select your Google account
3. You're automatically registered and logged in

### passkey (passwordless)

If you've registered a passkey, click **"Sign in with passkey"** on the login page. Authenticate with your device's biometric (Touch ID, Windows Hello, or phone) — no password or 2FA code needed.

---

## set up two-factor authentication

After your first login, you'll be prompted to set up 2FA:

1. Open an authenticator app (Google Authenticator, Authy, 1Password, etc.)
2. Scan the QR code displayed on screen
3. Enter the 6-digit code from your authenticator
4. Save your **backup codes** somewhere safe — you'll need them if you lose your device

!!! tip "2FA is optional but recommended"
    You can skip 2FA setup, but it adds an important layer of security for admin accounts.

---

## create your first site

Sites are the top-level organizational unit — think of them as locations, departments, or projects.

1. Click **"Create Site"** in the dashboard
2. Enter a **Site Name** (e.g., "NYC Gallery")
3. Enter a **Site ID** (e.g., `nyc-gallery`) — this is permanent and used in URLs
4. Click **Create**

You're automatically assigned as the owner with full access.

---

## add your first machine

1. Download the agent installer (download button in the dashboard header)
2. Run the installer on your target Windows machine
3. A pairing phrase appears and your browser opens to the authorization page
4. Select a site and click **"Authorize"**
5. The agent receives credentials and starts syncing

Within 30 seconds, the machine appears in your dashboard:

- Green **Online** indicator
- CPU, memory, disk metrics populating
- Agent version displayed

---

## understanding the dashboard layout

### machine cards

Each machine is displayed as a card showing:

- **Machine name** (hostname)
- **Online/Offline status** with last seen time
- **System metrics** — CPU, memory, disk, GPU percentages
- **Process list** — configured processes with status indicators
- **Agent version**

### view modes

- **Card View** — Visual grid of machine cards with sparkline charts
- **List View** — Compact table with sortable columns

### navigation

- **Dashboard** — Main monitoring view
- **Deployments** — Software deployment management
- **Projects** — Project file distribution
- **Logs** — Activity event viewer
- **Admin** — User and system management (admin only)

---

## next steps

- [**Add processes**](process-management.md) — Configure applications for monitoring
- [**Deploy software**](deployments.md) — Push installers to machines
- [**Set up alerts**](admin/email-alerts.md) — Get notified when things go wrong
- [**Invite users**](admin/user-management.md) — Add team members with role-based access
