# Installation

There are three ways to install the Owlette agent on a Windows machine.

---

## Method 1: Dashboard Download (Recommended)

The simplest method — download the installer from the web dashboard and run it.

### Steps

1. Log into the Owlette dashboard
2. Click the **download button** in the header bar (shows the latest version)
3. Save the `.exe` installer to the target machine
4. Run the installer **as Administrator**
5. Follow the installation wizard
6. After installation, the agent GUI opens — click **"Join Site"**
7. Your browser opens the dashboard for OAuth authentication
8. Log in and authorize the agent — credentials are exchanged automatically

---

## Method 2: Remote Deployment

Deploy the agent to machines you already have access to — without touching them physically.

1. In the dashboard, go to **Deployments**
2. Click **"New Deployment"**
3. Configure:
    - **Name**: e.g., "Owlette Agent v2.1.8"
    - **Installer URL**: Direct download link to the installer `.exe`
    - **Silent Flags**: `/VERYSILENT /SUPPRESSMSGBOXES`
    - **Verify Path**: `C:\ProgramData\Owlette\agent\src\owlette_service.py`
4. Select target machines
5. Click **Deploy**

!!! warning "Prerequisites"
    Remote deployment requires the target machine to already have a running Owlette agent (to receive the deployment command). Use this method for **upgrading** existing agents or deploying other software.

---

## Method 3: Manual Installation (Development)

For development or custom setups:

```bash
# Clone the repository
git clone https://github.com/theexperiential/Owlette.git
cd Owlette/agent

# Install Python dependencies
pip install -r requirements.txt

# Run the service install script (as Administrator)
scripts\install.bat
```

The install script:

1. Installs NSSM if not present
2. Creates the `OwletteService` Windows service
3. Configures the service to auto-start on boot
4. Starts the service

---

## OAuth Registration Flow

When the agent connects for the first time, it authenticates via OAuth:

```
Agent GUI → User clicks "Join Site"
    │
    ▼
Browser opens → Dashboard setup page
    │
    ▼
User logs in → Dashboard generates registration token
    │
    ▼
OAuth callback → Agent receives token via localhost:8765
    │
    ▼
POST /api/agent/auth/exchange
    │
    ├── Custom Firebase Token (1-hour expiry)
    └── Refresh Token (long-lived, stored encrypted locally)
    │
    ▼
Agent authenticated — starts syncing
```

The entire flow is browser-based — no codes to copy or enter. The agent starts a local callback server on port 8765, the dashboard redirects back with credentials after authentication, and the agent stores them encrypted on disk.

---

## Post-Installation Verification

After installation, verify the agent is running:

### Check Windows Services

1. Open Services (`Win + R` → `services.msc`)
2. Find **"OwletteService"**
3. Status should be **"Running"**

### Check Logs

```
C:\ProgramData\Owlette\logs\service.log
```

Look for:

```
INFO: Owlette service started successfully
INFO: Firebase client initialized for site: your_site_id
INFO: Firebase client started successfully
```

### Check Dashboard

The machine should appear in your site's dashboard within 30 seconds with:

- Green "Online" indicator
- CPU, memory, disk metrics populating
- Agent version displayed

### Check System Tray

An owl icon should appear in the Windows system tray. Right-click it for status and options.

---

## Installer Details

The Owlette installer is built with [Inno Setup](https://jrsoftware.org/isinfo.php) and bundles:

| Component | Purpose |
|-----------|---------|
| **Embedded Python** | Python 3.9+ interpreter (no system Python needed) |
| **NSSM** | Service manager for reliable Windows service operation |
| **Agent source** | All Python modules in `agent/src/` |
| **Configuration GUI** | CustomTkinter-based local configuration tool |
| **System tray** | Background tray icon for status monitoring |

### Silent Installation Flags

For automated deployment:

| Flag | Description |
|------|-------------|
| `/VERYSILENT` | No UI, no progress bar |
| `/SUPPRESSMSGBOXES` | Suppress all message boxes |
| `/DIR="C:\ProgramData\Owlette"` | Custom install directory |
| `/NORESTART` | Don't restart after installation |

Example:

```bash
Owlette-Installer-v2.1.8.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

---

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| **OS** | Windows 10 or later |
| **RAM** | 50 MB (agent overhead) |
| **Disk** | ~200 MB (including embedded Python) |
| **Network** | Internet access for cloud sync (optional — works offline) |
| **Permissions** | Administrator (for service installation) |
