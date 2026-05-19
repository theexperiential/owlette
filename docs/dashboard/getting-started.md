# dashboard getting started

This guide walks you through your first experience with the owlette dashboard - from login to seeing your first machine.

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

If you've registered a passkey, click **"Sign in with passkey"** on the login page. Authenticate with your device's biometric (Touch ID, Windows Hello, or phone) - no password or 2FA code needed.

---

## set up two-factor authentication

After your first login, you'll be prompted to set up 2FA:

1. Open an authenticator app (Google Authenticator, Authy, 1Password, etc.)
2. Scan the QR code displayed on screen
3. Enter the 6-digit code from your authenticator
4. Save your **backup codes** somewhere safe - you'll need them if you lose your device

!!! tip "2FA is optional but recommended"
    You can skip 2FA setup, but it adds an important layer of security for admin accounts.

---

## create your first site

Sites are the top-level organizational unit - think of them as locations, departments, or projects.

1. If you have no sites yet, click **"create your first site"**. Otherwise open the site switcher, choose **"manage sites"**, then click **"new site"**.
2. In **"create new site"**, enter a **"site name"** (e.g., "NYC Gallery").
3. Keep the generated **"site ID"** or open **"customize site ID"** to set one manually. The ID is permanent and used in URLs.
4. Click **"create site"**.

You're automatically assigned as the owner with full access.

---

## add your first machine

1. Click **"add machine"** on the dashboard.
2. On the **"enter code"** tab, download or copy the agent installer link and run it on the target Windows machine.
3. Enter the 3-word **"pairing phrase"** shown on that machine.
4. Click **"authorize"**. The success state reads **"machine authorized"**, and the machine appears on the dashboard shortly.

For unattended or bulk installs, use the **"generate code"** tab instead. Click **"generate code"**, then copy the generated **"pairing phrase"** or **"silent install command"**. Generated pairing phrases expire in 10 minutes.

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
- **System metrics** - CPU, memory, disk, GPU percentages
- **Process list** - configured processes with status indicators
- **Agent version**

### view modes

- **Card View** - Visual grid of machine cards with sparkline charts
- **List View** - Compact table with sortable columns

### navigation

- **dashboard** - Main monitoring view
- **cortex** - AI chat for machine management
- **deploy** - Software deployment management
- **roost** - Content-addressed file sync, version publishing, and rollback at `/roosts`
- **logs** - Activity event viewer
- **admin panel** - User and system management for superadmins

---

## next steps

- [**Add processes**](process-management.md) - Configure applications for monitoring
- [**Deploy software**](deployments.md) - Push installers to machines
- [**Set up alerts**](admin/email-alerts.md) - Get notified when things go wrong
- [**Invite users**](admin/user-management.md) - Add team members with role-based access
