# self-update

The owlette agent can update itself remotely — no physical access to the machine required.

---

## how it works

The self-update is handled directly by the service's command handler in `owlette_service.py`:

1. **Receives** the `update_owlette` command from Firestore
2. **Downloads** the new installer to a temp directory
3. **Stops** the owlette service
4. **Executes** the installer silently (Inno Setup with `/VERYSILENT`)
5. **Installer upgrades** in place — preserves `config.json` and credentials
6. **Service restarts** automatically (NSSM or installer triggers restart)
7. **New version** connects to Firestore and reports updated `agent_version`

---

## triggering an update

### from the dashboard

1. Navigate to your machine in the dashboard
2. Click the **"Update owlette"** button
3. Select the target version (or use "latest")
4. Confirm the update

The dashboard sends an `update_owlette` command with the installer URL and target version.

### what gets preserved

| Preserved | Not Preserved |
|-----------|---------------|
| `config.json` (process settings, site connection) | Old agent source code |
| OAuth tokens (encrypted) | Old Python packages |
| Log files | Old NSSM binary |

The installer backs up `config.json` before upgrading and restores it afterward.

---

## update command payload

```json
{
  "type": "update_owlette",
  "installer_url": "https://firebasestorage.googleapis.com/.../Owlette-Installer-v2.1.8.exe",
  "version": "2.1.8",
  "timestamp": 1711234567890
}
```

---

## version verification

After the update completes:

1. The new agent starts and reads its version from `agent/VERSION`
2. Reports `agent_version` in its next heartbeat to Firestore
3. Dashboard displays the new version in the machine card
4. You can verify in the GUI footer or system tray

---

## troubleshooting updates

### update stuck

If the machine goes offline and doesn't come back:

1. **Check physically** — the machine may need manual intervention
2. **Check logs** at `C:\ProgramData\Owlette\logs\service.log`
3. **Restart service** manually: `net start OwletteService`

### version didn't change

If the agent reports the same version after update:

1. The installer may have failed silently
2. Check for Inno Setup log files in the temp directory
3. Verify the installer URL was accessible from the target machine

### rollback

To rollback to a previous version:

1. In the Admin Panel → Installer Management, find the old version
2. Set it as "latest"
3. Trigger another update to the old version
