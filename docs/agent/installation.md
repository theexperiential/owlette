# Installation

There are three ways to install and authenticate the Owlette agent on a Windows machine.

---

## Method 1: Interactive Install (Recommended)

Download the installer, run it, and pair from your phone or browser.

### Steps

1. Log into the Owlette dashboard
2. Click the **download button** in the header bar (shows the latest version)
3. Save the `.exe` installer to the target machine
4. Run the installer **as Administrator**
5. Follow the installation wizard
6. A console window appears with a **pairing phrase** (3 random words)
7. Your browser opens automatically to the authorization page
8. Select a site and click **"Authorize"**
9. The agent receives credentials and the installer completes

The entire flow takes under a minute. Credentials are stored encrypted on disk — you won't need to re-authenticate unless you explicitly remove the machine.

---

## Method 2: Silent Install with `/ADD=` (Bulk Deployment)

Deploy to many machines without any interaction. Generate a pairing phrase from the dashboard, then run the installer silently.

### Steps

1. On the dashboard, click the **"+"** button next to the view toggle
2. Select the **"Generate Code"** tab
3. Copy the pairing phrase (e.g., `silver-compass-drift`)
4. Run on each target machine:

```bash
Owlette-Installer-v2.4.1.exe /ADD=silver-compass-drift /SILENT
```

!!! info "Phrase expiry"
    Generated phrases expire after **10 minutes**. Generate a new one from the dashboard if needed.

### Silent Installation Flags

| Flag | Description |
|------|-------------|
| `/ADD=phrase` | Pre-authorized pairing phrase (skips interactive pairing) |
| `/SILENT` | Minimal UI (shows progress bar only) |
| `/VERYSILENT` | No UI at all |
| `/SUPPRESSMSGBOXES` | Suppress all message boxes |
| `/DIR="C:\path"` | Custom install directory |
| `/NORESTART` | Don't restart after installation |

Example (fully silent bulk deploy):

```bash
Owlette-Installer-v2.4.1.exe /ADD=silver-compass-drift /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

---

## Method 3: Remote Deployment (Upgrades)

Deploy agent updates to machines that already have Owlette installed.

1. In the dashboard, go to **Deployments**
2. Click **"New Deployment"**
3. Configure:
    - **Name**: e.g., "Owlette Agent v2.4.1"
    - **Installer URL**: Direct download link to the installer `.exe`
    - **Silent Flags**: `/VERYSILENT /SUPPRESSMSGBOXES`
    - **Verify Path**: `C:\ProgramData\Owlette\agent\src\owlette_service.py`
4. Select target machines
5. Click **Deploy**

!!! warning "Prerequisites"
    Remote deployment requires the target machine to already have a running Owlette agent (to receive the deployment command). Use this method for **upgrading** existing agents or deploying other software.

---

## Method 4: Manual Installation (Development)

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

After installing, run the pairing flow manually:

```bash
cd C:\ProgramData\Owlette\agent\src
python configure_site.py
```

---

## How Pairing Works

When the agent connects for the first time, it authenticates via a device code flow:

```
Installer runs configure_site.py
    │
    ▼
Agent requests pairing phrase from server
    │
    ▼
Console displays phrase (e.g., "silver-compass-drift")
Browser auto-opens to owlette.app/add
    │
    ▼
User selects site → clicks "Authorize"
    │
    ▼
Server generates tokens → agent polls and receives them
    │
    ├── Access Token (1-hour expiry, auto-refreshes)
    └── Refresh Token (never expires, admin-revocable)
    │
    ▼
Tokens encrypted to C:\ProgramData\Owlette\.tokens.enc
Agent authenticated — starts syncing
```

Three ways to authorize:

| Method | When to use |
|--------|------------|
| **Browser auto-open** | Default — browser opens on the machine with phrase pre-filled |
| **Dashboard "+" button** | Enter the phrase on the dashboard from any device |
| **`/ADD=` flag** | Pre-authorized phrase for silent/bulk installs |

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

## Uninstallation

**Windows Settings** → **Apps** → **Owlette** → **Uninstall**

The uninstaller will:

1. Stop the Owlette service
2. Remove the NSSM service wrapper
3. Remove Windows Defender exclusions
4. Delete program files from `C:\ProgramData\Owlette`

!!! note "Data preservation"
    Configuration, tokens, and logs in `C:\ProgramData\Owlette\` are preserved by default. To fully remove all data after uninstalling: `rd /s /q C:\ProgramData\Owlette`

---

## Installer Details

The Owlette installer is built with [Inno Setup](https://jrsoftware.org/isinfo.php) and bundles:

| Component | Purpose |
|-----------|---------|
| **Embedded Python** | Python 3.11 interpreter (no system Python needed) |
| **NSSM** | Service manager for reliable Windows service operation |
| **Agent source** | All Python modules in `agent/src/` |
| **Configuration GUI** | CustomTkinter-based local configuration tool |
| **System tray** | Background tray icon for status monitoring |

---

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| **OS** | Windows 10 or later (64-bit) |
| **RAM** | 50 MB (agent overhead) |
| **Disk** | ~200 MB (including embedded Python) |
| **Network** | Internet access for cloud sync |
| **Permissions** | Administrator (for service installation) |
