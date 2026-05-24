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

## Agent Installer Release (build + upload to Firebase)

**IMPORTANT: Always version up AND update the changelog BEFORE building the installer.** Bump with `node scripts/sync-versions.js X.Y.Z` and commit BEFORE running `build_installer_full.bat` — the installer bakes the version into the exe filename and binary.

**IMPORTANT: `docs/changelog.md` MUST be updated before every installer build.** Add a new `## [X.Y.Z] - YYYY-MM-DD` section summarising all changes since the last release. Never build or upload an installer without a matching changelog entry.

```bash
# 1. Update changelog, bump version, commit, push
# Edit docs/changelog.md → add [X.Y.Z] section
node scripts/sync-versions.js X.Y.Z
git add -A && git commit -m "chore: bump version to X.Y.Z" && git push origin dev

# 2. Build installer (~5 min, non-interactive)
# build_installer_full.bat ends with `pause` and has `pause` on every error
# branch, so it MUST be run with stdin redirected from NUL or it will hang
# the harness forever. Invoke by FULL PATH (cmd /c won't reliably cd via
# PowerShell quote-stripping) and capture the log explicitly. Run in the
# background — exit code 0 means the .exe is built; check the log on failure.
#
#   powershell (foreground/background):
#     cmd /c "C:\Users\admin\Documents\Git\Owlette\agent\build_installer_full.bat < NUL > C:\Users\admin\AppData\Local\Temp\installer-build.log 2>&1"
#
#   bash:
#     cd c:/Users/admin/Documents/Git/Owlette/agent && cmd //c "build_installer_full.bat" < /dev/null > /tmp/installer-build.log 2>&1
#     # (if //c gets mangled by Git Bash, fall back to the powershell cmd /c form above)
#
# DO NOT use `cd agent && powershell -Command "& './build_installer_full.bat'"` —
# the trailing pause will hang non-interactive shells indefinitely.
# Output: agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# 3. Compute checksum
sha256sum agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# 4. Upload via API (3-step: request URL → upload binary → finalize)
# Endpoint is `/api/installer/upload` (api-sprint route — old `/api/admin/installer/upload` was removed).
# Auth: api key with `installer=*:write` scope (superadmin-only at minting). `x-api-key` or `Authorization: Bearer owk_…` both work.
# Idempotency-Key REQUIRED on both POST and PUT — the route is wrapped in `withIdempotency(..., { requireKey: true })`.
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://dev.owlette.app"  # or https://owlette.app for prod

# Step 1: Get signed upload URL
curl -s -X POST "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-X.Y.Z-$(date +%s)" \
  -d '{"version":"X.Y.Z","fileName":"Owlette-Installer-vX.Y.Z.exe","releaseNotes":"...","setAsLatest":true}'
# → returns uploadUrl, uploadId, storagePath, expiresAt (15-min window)

# Step 2: Upload binary to the signed GCS URL (no Idempotency-Key here — it's a direct GCS PUT)
curl -X PUT "$UPLOAD_URL" -H "Content-Type: application/octet-stream" \
  --data-binary @agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# Step 3: Finalize (verifies file in storage, computes/checks checksum, writes installer_metadata, sets as latest)
curl -s -X PUT "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-X.Y.Z-$(date +%s)" \
  -d '{"uploadId":"<from step 1>","checksum_sha256":"<sha256 from earlier>"}'
# checksum_sha256 is optional — server computes it if omitted, but providing it gets a 412 `checksum_mismatch` on corruption.
```

---

## Critical Rules

### Do
- Run full build first before quick build (creates Python runtime + deps)
- Use `build_installer_quick.bat` for source-only changes during development
- Test with `python owlette_service.py debug` before building installer
- Check `agent/VERSION` matches `/VERSION` before release

### Don't
- **Never edit `owlette_installer.iss`** without reading `skills/resources/installer-build-system.md` first — the config backup/restore logic, OAuth flow, and silent install behavior are interconnected
- **Never change the install path** from `C:\ProgramData\Owlette` — NSSM paths, service registration, and the Inno Setup script use this via `{commonappdata}`
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
