# Owlette

<div align="center">
<img src=".github/images/icon.png" alt="Owlette" width="50%"/>
</div>

### _Cloud-Connected Process Management & Remote Deployment System_

**Version 2.2.1** - A modern, cloud-connected process management system for Windows that combines:

- **Windows Service** - Monitors and auto-restarts applications
- **Web Dashboard** - Real-time monitoring and control from anywhere
- **Remote Deployment** - Install software across multiple machines
- **Live Metrics** - CPU, memory, disk, and GPU tracking
- **Firebase Sync** - Bidirectional cloud communication
- **Multi-Site Management** - Manage machines across multiple locations
- **Cortex AI** - LLM-powered assistant with tool-calling capabilities

Perfect for managing TouchDesigner installations, digital signage, kiosks, media servers, and any Windows application fleet.

<div align="center">
<img src=".github/images/screenshot-agent.png" alt="Owlette Agent Screenshot" width="100%"/>
<p><em>Owlette Agent - Windows system tray application for local process management</em></p>
</div>

<br />

<div align="center">
<img src=".github/images/screenshot-dashboard.png" alt="Owlette Dashboard Screenshot" width="100%"/>
<p><em>Owlette Dashboard - Web-based control panel for remote machine monitoring</em></p>
</div>
<br />

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
   - [Agent (Windows Service)](#agent-installation)
   - [Web Dashboard](#web-dashboard-setup)
3. [Web Dashboard](#web-dashboard)
4. [Remote Deployment](#remote-deployment)
5. [Project Distribution](#project-distribution)
6. [Agent Usage](#agent-usage)
7. [Agent UI Features](#ui-features)
8. [Agent Configuration](#configuration)
9. [Uninstallation](#uninstallation)
10. [Version Management](#version-management)
11. [Contributing](#contributing)
12. [License](#license)

<a id="features"></a>

## Features

### Cloud & Remote Management
- **Web Dashboard** - Modern Next.js dashboard for monitoring and control from anywhere
- **Real-Time Sync** - Bidirectional Firebase/Firestore synchronization
- **Multi-Machine Management** - Control multiple Windows machines from one interface
- **Multi-Site Support** - Organize machines across different locations/installations
- **Multi-User Access** - Secure user accounts with role-based permissions
- **Site Access Control** - Admins assign site access; users see only their assigned sites
- **Remote Software Deployment** - Install applications silently across multiple machines
- **Project File Distribution** - Sync project files (ZIPs, .toe files) across your fleet
- **Live Metrics Dashboard** - Real-time CPU, memory, disk, and GPU monitoring
- **Remote Screenshots** - Capture and view screenshots from managed machines
- **Activity Logs** - Track events and actions across your fleet
- **Email Alerts & Webhooks** - Configurable notifications for machine events

### Authentication & Security
- **Email + Password** - Standard email/password authentication
- **Google OAuth** - Sign in with Google
- **Passkeys / WebAuthn** - Passwordless authentication with biometrics or security keys
- **Two-Factor Authentication** - TOTP-based 2FA for added security
- **Role-Based Access** - Admin and user roles with site-level permissions
- **Encrypted Sessions** - HTTPOnly cookie-based session management

### Windows Service (Agent)
- **Auto-Start Processes** - Launch applications automatically on system boot
- **Crash Recovery** - Automatically restart applications if they freeze or crash
- **Process Monitoring** - Real-time status tracking and responsiveness checking
- **PID Recovery** - Reconnect to existing processes after service restart
- **Priority Control** - Set process priority (Low, Normal, High, Realtime)
- **Visibility Control** - Show or hide process windows
- **Configurable Retries** - Set relaunch attempts before system restart

### Configuration & Control
- **System Tray Icon** - Quick access to features and service control
- **Configuration GUI** - Easy-to-use Windows application for setup
- **Web-Based Config** - Edit process settings from the dashboard
- **Autolaunch Toggle** - Enable/disable processes without editing config
- **Instant Sync** - Changes sync between GUI, service, and web in ~1-2 seconds

### Cortex AI
- **LLM-Powered Assistant** - Chat interface for managing your fleet with natural language
- **Tool Calling** - AI executes commands on agents via Firestore relay
- **Multi-Provider** - Supports Anthropic and OpenAI models

### Advanced Features
- **Silent Deployment** - Install software with automatic silent flags detection
- **Deployment Templates** - Save and reuse installer configurations
- **Deployment Cancellation** - Stop installations remotely
- **Installation Verification** - Confirm successful deployments
- **Project Distribution** - Distribute project files with ZIP extraction and verification
- **URL-Based Distribution** - Zero infrastructure cost using your own file hosting
- **Self-Update** - Agents can update themselves from the web dashboard
- **Offline Mode** - Agent continues working even if cloud disconnects
- **Comprehensive Logging** - Detailed logs for troubleshooting

<a id="installation"></a>

## Installation

Owlette consists of two components:
1. **Agent** - Windows service running on each managed machine
2. **Web Dashboard** - Next.js web application for remote management

### Prerequisites

**For Agent (Windows Service):**
- Windows 10/11 or Windows Server
- Python 3.9+ (installer will auto-install if missing)
- Firebase project with Firestore enabled (see [Firebase Setup Guide](docs/setup/firebase.md))

**For Web Dashboard:**
- Node.js 18.x or higher
- Same Firebase project as agent

**Quick Start:**
```bash
# Clone the repository
git clone https://github.com/theexperiential/Owlette.git
cd Owlette
```

<a id="agent-installation"></a>

### Agent (Windows Service) Installation

#### Recommended: Installer

Download the installer from the Owlette web dashboard. The installer handles everything automatically:
- Installs embedded Python runtime
- Installs all dependencies
- Opens browser for OAuth authorization
- Registers the agent with your site
- Installs and starts the Windows service

See [agent/INSTALLER-USAGE.md](agent/INSTALLER-USAGE.md) for the full OAuth flow documentation.

#### Manual Installation

1. Install the required Python packages:

    ```bash
    cd agent
    pip install -r requirements.txt
    ```

2. Create folders named `config`, `logs`, and `tmp` in the `agent` folder.

3. Run the GUI to configure and authenticate:
    ```bash
    cd agent/src
    python owlette_gui.py
    ```

4. Install and start the Windows service:
    ```bash
    cd agent/src
    python owlette_service.py install
    python owlette_service.py start
    ```

See the full [Agent README](agent/README.md) for more details.

<a id="web-dashboard-setup"></a>

### Web Dashboard Installation

See the full [Web Dashboard README](web/README.md) for detailed instructions.

**Quick Setup:**
```bash
cd web
npm install

# Configure environment variables
cp .env.example .env.local
# Edit .env.local with your Firebase config

# Development
npm run dev
# Access at http://localhost:3000

# Production
npm run build
npm start
```

**Deployment:**
Deploy to Railway, Vercel, or any Node.js hosting platform. See [web/README.md](web/README.md) for platform-specific instructions.

---

<a id="web-dashboard"></a>

## Web Dashboard

The Owlette web dashboard provides a modern interface for managing all your machines from anywhere.

### Machine Monitoring
- Real-time status of all managed machines
- Live system metrics (CPU, memory, disk, GPU)
- Process status and health monitoring
- Connection status and last heartbeat
- Remote screenshot capture

### Process Management
- Start/stop processes remotely
- Edit process configuration from web
- Toggle autolaunch for any process
- View process runtime information

### Multi-Site Organization
- Create multiple sites (locations/installations)
- Organize machines by site
- Switch between sites instantly
- Site-level management and permissions

### Dashboard Views
- Card view for overview
- List view for detailed information
- Collapsible machine details
- Real-time updates via Firebase listeners

### Admin Panel
- **User Management** - Invite users, assign roles and site access
- **Installer Management** - Upload and manage agent installers
- **System Presets** - Create preset configurations for new machines
- **Token Management** - Manage OAuth tokens
- **Webhooks** - Configure event notifications
- **Email Alerts** - Test and manage email notifications

### Activity Logs
- Track machine events, process changes, and user actions
- Filterable event history

### Cortex AI
- Natural language interface for fleet management
- LLM-powered tool calls relayed to agents via Firestore
- Supports Anthropic and OpenAI models

### Accessing the Dashboard

1. **Locally:** `http://localhost:3000` after running `npm run dev`
2. **Production:** Your deployed URL (e.g., Railway)
3. **Authentication:** Email/Password, Google OAuth, Passkeys, or 2FA

---

<a id="remote-deployment"></a>

## Remote Deployment

Deploy software silently across multiple machines from the web dashboard.

### Features

- **Silent Installation** - Unattended software deployment
- **Multi-Machine Targets** - Deploy to one or many machines at once
- **Deployment Templates** - Save configurations for reuse
- **Real-Time Progress** - Watch installations as they happen
- **Cancellation** - Stop in-progress installations
- **Verification** - Confirm successful deployment

### Usage

1. Navigate to the **Deploy Software** section in the web dashboard
2. Create a new deployment or use a template
3. Configure:
   - Installer URL (direct download link)
   - Silent flags (e.g., `/S`, `/VERYSILENT`)
   - Optional verification path
4. Select target machines
5. Deploy!

### Supported Installers

Works with any installer that supports silent/unattended mode:
- NSIS installers (`/S`)
- InnoSetup (`/VERYSILENT /SUPPRESSMSGBOXES`)
- MSI packages (`/quiet /norestart`)
- Custom installers (specify your own flags)

**Examples:**
- TouchDesigner: `/S`
- Notepad++: `/S`
- Chrome: `/silent /install`

See the [Deployment Guide](docs/dashboard/deployments.md) for detailed setup and examples.

---

<a id="project-distribution"></a>

## Project Distribution

Distribute project files (ZIPs, TouchDesigner .toe files, media assets) across multiple machines.

### Features

- **URL-Based Distribution** - Zero infrastructure cost - paste any URL (Dropbox, Google Drive, your hosting)
- **Automatic Extraction** - Downloads and extracts ZIP files to specified location
- **Real-Time Progress** - Watch download and extraction progress per machine
- **File Verification** - Confirm critical files exist after extraction
- **Distribution Templates** - Save common project configurations
- **Default Location** - Files extract to `~/Documents/OwletteProjects` by default

### Usage

1. Navigate to **Distribute Projects** in the web dashboard
2. Create a new distribution:
   - **Name**: "Summer Show 2024"
   - **Project URL**: Direct download link to your ZIP (Dropbox, Drive, etc.)
   - **Extract To**: Optional custom path (default: `~/Documents/OwletteProjects`)
   - **Verify Files**: Optional comma-separated list of critical files to check (e.g., `project.toe, Assets/`)
3. Select target machines
4. Distribute!

### Perfect For

- TouchDesigner project distribution (.toe files + media)
- Digital signage content updates
- Multi-GB project files with assets
- Syncing configurations across machines

### Cost-Effective Architecture

**Zero Owlette Infrastructure Costs:**
- Users host files on their own service (Dropbox, Google Drive, Backblaze, etc.)
- Machines download directly from provided URL
- Only Firestore operations are used (~$0.0001 per distribution)

See the [Project Distribution Guide](docs/dashboard/project-distribution.md) for detailed setup and examples.

---

<a id="agent-usage"></a>

## Agent Usage

### Using the Installer (Recommended)

1. Download the installer from the Owlette web dashboard
2. Run the installer - it opens your browser for OAuth authorization
3. Authorize the agent to join your site
4. The installer completes automatically - service starts, tray icon appears

### Manual Usage

1. Run the GUI to configure processes:

    ```bash
    cd agent/src
    python owlette_gui.py
    ```

2. Follow the on-screen instructions to authenticate and configure the processes you want to manage.

3. Install the Windows service (as administrator):

    ```bash
    cd agent/src
    python owlette_service.py install
    python owlette_service.py start
    ```

4. The system tray icon will automatically run with the service. To run the GUI separately:

    ```bash
    cd agent/src
    python owlette_gui.py
    ```

<a id="ui-features"></a>

## Agent UI Features

### System Tray Icon

#### Right-Click Menu

- **Open Config**: Brings up the Owlette Configuration window where you can manage and monitor processes.
- **Start on Login**: Allows you to toggle whether the service starts upon system login.
- **Restart**: Restarts the Owlette service.
- **Exit**: Closes the Owlette service and any open Configuration windows.

<a id="configuration"></a>

## Agent Configuration

### Overview

The Configuration GUI provides a visual interface for managing processes and settings. It features a dark theme and provides functionalities like adding, removing, and reordering processes.

### Process Details

- **Autolaunch/Manage**: Enables or disables monitoring for the selected process. If enabled, Owlette will check the process every 10 seconds. If it is unresponsive, it will attempt to close and relaunch it. If the process ID (PID) is no longer found, Owlette will attempt to relaunch it automatically.
- **Name**: Text field to enter the name of the process.
- **Exe Path**: Text field to specify the executable path. Includes a "Browse" button.
- **File Path / Cmd Line Args**: Text field for additional file paths or command-line arguments. Includes a "Browse" button.
- **Launch Time Delay (s)**: Time delay in seconds before the process starts.
- **Time to Initialize (s)**: Total time in seconds to give a process to fully initialize before checking responsiveness.
- **Relaunch Attempts til Restart**: Number of relaunch attempts before a system restart is triggered. Owlette will prompt with a 30 second countdown window which you may initiate, pause, or cancel.
- **Priority**: Set the priority level (how much CPU time the process gets compared to other running processes).
- **Window Visibility**: Set the process window to be shown or hidden.
- **Add**: Adds a new process to the Process Startup List based on the details provided.

### Process Startup List

- **Listbox**: Displays the list of configured processes. The list is ordered, so your processes will be started in the order you define.
- **Kill**: Terminates the selected and running process.
- **Del**: Removes the selected process from the list.
- **Up**: Moves the selected process up in the list (start it before other processes).
- **Down**: Moves the selected process down in the list (start it after other processes).
- **Save Changes**: Saves any modifications to the selected process. Note that changes are also saved when you press your return key in a text field, or click anywhere outside of one in the UI.

<a id="uninstallation"></a>

## Uninstallation

To uninstall the Owlette service and Python dependencies, run `agent/uninstall.bat`:

```bash
cd agent
uninstall.bat
```

Alternatively, to just remove the service, run the following command as an administrator:

```bash
cd agent/src
python owlette_service.py remove
```

This will remove the Owlette service from your system.

---

## Troubleshooting

### Logs
Logs are stored in the `logs` folder, per script. `service.log` for the service, `gui.log` for the GUI, `tray.log` for the tray icon. Check these logs for debugging information.

See [docs/troubleshooting.md](docs/troubleshooting.md) for more common issues and solutions.

---

<a id="version-management"></a>

## Version Management

Owlette uses a unified versioning system across all components.

**Current Version:** 2.2.0

### For Developers

When releasing a new version, use the sync script to keep all components aligned:

```bash
# Check current versions
node scripts/sync-versions.js

# Bump to new version (updates product, agent, and web)
node scripts/sync-versions.js 2.3.0
```

This automatically updates:
- `/VERSION` (product version)
- `agent/VERSION` (Windows service)
- `web/package.json` (dashboard)

**Note:** Firestore rules version is independent (tracks schema changes only).

See [docs/internal/version-management.md](docs/internal/version-management.md) for complete details.

---

<a id="contributing"></a>

## Contributing

Feel free to contribute by submitting pull requests.

**Before submitting:**
- Use `node scripts/sync-versions.js` for version bumps
- Update CHANGELOG.md with your changes
- Ensure all tests pass (`npm test` in web/, `pytest` in agent/)
- Follow existing code style and patterns

<a id="license"></a>

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
