# Deployments

Deploy software remotely to one or many machines. Owlette downloads and silently installs applications, tracking progress in real-time.

---

## Overview

The deployment system allows you to:

- Push installers to multiple machines simultaneously
- Track download and installation progress per machine
- Verify installations with path checking
- Save deployment configurations as templates
- Cancel in-progress deployments

---

## Creating a Deployment

1. Navigate to **Deployments** from the dashboard menu
2. Click **"New Deployment"**
3. Fill in the deployment configuration:

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Descriptive name (e.g., "TouchDesigner 2025") |
| **Installer URL** | Yes | Direct HTTPS download link to the `.exe` installer |
| **Silent Flags** | Yes | Flags for unattended installation |
| **Verify Path** | No | File path to check after installation |
| **Save as Template** | No | Save configuration for reuse |

4. Select target machines (online, all, or specific)
5. Click **"Deploy to N Machines"**

---

## Silent Installation Flags

Different installer frameworks use different flags:

| Installer Type | Silent Flags | Example Software |
|----------------|--------------|-----------------|
| **Inno Setup** | `/VERYSILENT /SUPPRESSMSGBOXES` | Owlette, many open-source tools |
| **NSIS** | `/S` | Notepad++, 7-Zip |
| **MSI** | `/qn` (with `msiexec /i`) | Windows Installer packages |
| **InstallShield** | `/s /v"/qn"` | Enterprise software |

!!! tip "Testing flags"
    Always test your silent flags on one machine before deploying to many. Run the installer manually with the flags to verify it completes without user interaction.

---

## Deployment Progress

The dashboard shows real-time status for each machine:

| Status | Description |
|--------|-------------|
| **Pending** | Command queued, waiting for agent |
| **Downloading** | Agent downloading installer (shows %) |
| **Installing** | Installer running |
| **Completed** | Installation successful |
| **Failed** | Installation failed (shows error) |
| **Cancelled** | Deployment was cancelled |
| **Uninstalled** | Software was uninstalled from this machine |

Overall deployment status is calculated automatically:

| Overall Status | Meaning |
|----------------|---------|
| **Pending** | All targets still pending |
| **In Progress** | At least one target downloading or installing |
| **Completed** | All targets completed |
| **Failed** | All non-cancelled targets failed |
| **Partial** | Mix of completed and failed targets |
| **Cancelled** | All targets cancelled |
| **Uninstalled** | All targets uninstalled |

---

## Deployment Templates

Save frequently-used configurations:

1. When creating a deployment, check **"Save as template"**
2. The template stores: name, installer URL, silent flags, verify path
3. Load templates from the dropdown in the deployment dialog
4. Edit or delete templates as needed

---

## Cancelling a Deployment

To cancel an in-progress deployment:

1. Find the deployment in the deployments list
2. Click **Cancel** next to the target machine
3. Machines that haven't started will skip the deployment
4. Machines currently downloading or installing will be stopped (the agent terminates the installer process tree)

!!! note
    Only targets in `pending`, `downloading`, or `installing` state can be cancelled. Targets that have already completed, failed, or been uninstalled cannot be cancelled.

---

## Deployment Flow

```
Dashboard creates deployment record in Firestore
    │
    ├── For each target machine:
    │     │
    │     ├── Write install_software command to pending queue
    │     │
    │     ├── Agent detects command
    │     │     │
    │     │     ├── Download installer to %TEMP%\owlette_installers\
    │     │     │   (progress: downloading 0% → 100%)
    │     │     │
    │     │     ├── Execute installer with silent flags
    │     │     │   (timeout: 40 minutes)
    │     │     │
    │     │     ├── Verify installation (if verify_path set)
    │     │     │
    │     │     └── Report result to Firestore
    │     │
    │     └── Dashboard updates per-machine status in real-time
    │
    └── Overall deployment status updates when all machines complete
```

---

## Troubleshooting

### "Download failed"

- Test the URL in a browser — it should directly download the file
- Ensure the URL is a direct download link (not a web page)
- Check that the agent machine has internet access
- For Dropbox: change `?dl=0` to `?dl=1`

### Installation Fails

- Verify silent flags are correct for the installer type
- Check if the installer requires specific prerequisites (e.g., .NET Framework)
- Review agent logs: `C:\ProgramData\Owlette\logs\service.log`
- Try installing manually with the same flags to diagnose

### Timeout

The default installation timeout is 40 minutes. Very large installers on slow connections may need the agent-side timeout adjusted in `installer_utils.py`.

!!! info "Automatic timeout cleanup"
    Firebase Cloud Functions automatically mark stale deployments as failed:

    - **Pending** targets that haven't started after **15 minutes** are marked failed
    - **Downloading/Installing** targets stuck for over **30 minutes** are marked failed

    This prevents deployments from appearing stuck indefinitely if a machine goes offline mid-deployment.

---

## Security

- Only deploy from **trusted sources** — the system does not verify installer signatures
- **HTTPS URLs are required** — the API rejects HTTP, `file://`, and other non-HTTPS protocols
- Optional **SHA256 checksum verification** — the agent supports verifying downloaded files against a SHA256 hash when provided via the command payload (not currently exposed in the dashboard UI)
- The agent runs as **SYSTEM** — installed software has full administrative access
- Pre-test installers before mass deployment
