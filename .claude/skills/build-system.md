# Build & Installer System Guidelines

**Applies To**: Build scripts, Inno Setup, NSSM service config, self-update, version management

---

## Build Pipeline

### Two Build Modes

| | Full Build | Quick Build |
|--|-----------|------------|
| **Script** | `build_installer_full.bat` | `build_installer_quick.bat` |
| **Duration** | 5-10 min | ~30 sec |
| **When** | First build, dependency changes | Source code changes only |

**Prerequisite**: Inno Setup 6 at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

### Version Bump Flow

```bash
node scripts/sync-versions.js 2.1.0   # Updates /VERSION, agent/VERSION, web/package.json
cd agent && build_installer_quick.bat  # Rebuild installer with new version
```

Version → `OWLETTE_VERSION` env var → Inno Setup reads it → installer filename + registry.

---

## Critical Rules

### Do
- Run full build first before quick build (creates Python runtime + deps)
- Use `build_installer_quick.bat` for source-only changes during development
- Test with `python owlette_service.py debug` before building installer
- Check `agent/VERSION` matches `/VERSION` before release

### Don't
- **Never edit `owlette_installer.iss`** without reading `skills/resources/installer-build-system.md` first — the config backup/restore logic, OAuth flow, and silent install behavior are interconnected
- **Never change the install path** from `C:\Owlette` — NSSM paths, service registration, and multiple batch scripts hardcode this
- **Never modify `python311._pth`** without understanding embedded Python import resolution — breaking this kills all imports
- **Never skip the Defender exclusion** in the installer — LibreHardwareMonitor's WinRing0 driver triggers false positives
- **Never change NSSM exit behavior** — exit code 0 = don't restart (graceful stop), non-zero = restart (crash recovery). `owlette_runner.py` depends on this.

---

## Key Files

| File | Purpose | Danger Level |
|------|---------|-------------|
| `owlette_installer.iss` | Inno Setup script — install/uninstall/upgrade logic | High |
| `build_installer_full.bat` | Downloads Python, pip, deps, NSSM, assembles package | Medium |
| `build_installer_quick.bat` | Copies source + compiles installer (fast iteration) | Low |
| `scripts/install.bat` | NSSM service registration (run during install) | High |
| `src/owlette_runner.py` | NSSM↔Service bridge, signal handling | High |
| `src/owlette_updater.py` | Self-update: stop → download → silent install → verify | High |
| `src/configure_site.py` | OAuth registration during install (localhost:8765) | Medium |
| `src/installer_utils.py` | Remote installer download/execute for deployments | Medium |
| `scripts/sync-versions.js` | Bumps version across all version files | Low |

---

## Self-Update Flow

```
Web dashboard sends update_owlette command
  → owlette_updater.py stops service via NSSM
  → Downloads new installer (3 retries, exponential backoff)
  → Validates file (size > 1KB, PE header)
  → Runs: installer.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS
  → Silent mode skips OAuth (ShouldConfigureSite = false when config exists)
  → install.bat re-registers service → NSSM starts it
  → Verifies service running after 10s
```

**Safety**: If update fails, old service config remains and NSSM restarts it.

---

## Config Backup During Upgrades

The installer handles config preservation:
1. `BackupConfigIfExists()` → copies to `%TEMP%\config.json.backup`
2. Files overwritten during install
3. `RestoreConfigIfBackedUp()` → restores UNLESS:
   - `DidRunOAuth == True` → keep fresh OAuth config (never overwrite new auth)
   - `WizardSilent() == True` → skip restore, agent syncs from Firestore

**This is the most fragile part of the build system.** Changing the backup/restore order or conditions can break upgrades.

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Python 3.11 not found" | Tkinter copy needs system Python 3.11 | Install Python 3.11 to `C:\Program Files\Python311` |
| Quick build fails | No Python runtime in `build/` | Run full build first |
| Installer hangs on silent update | `ShouldConfigureSite()` returned true | Check config.json exists at `C:\ProgramData\Owlette\config\` |
| Service won't start after update | Import errors from missing deps | Full rebuild needed |
| Installer flagged by AV | Missing Defender exclusion | Check `Add-MpPreference` step ran |

---

## When This Skill Activates

Working on build scripts, installer config, version management, NSSM setup, or self-update code.
