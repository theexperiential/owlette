# Build & Installer System Guidelines

**Applies To**: Build scripts, Inno Setup, NSSM service config, self-update, version management

---

## Build Pipeline

### Two Build Modes

| | Full Build | Quick Build |
|--|-----------|------------|
| **Script** | `build_installer_full.bat` | `build_installer_quick.bat` |
| **Duration** | 5-10 min (longer on a cold cargo cache) | ~30 sec |
| **When** | First build, dependency changes, desktop app changes | Agent source changes only |

**Prerequisites**: Inno Setup 6 at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`; Node 22 + npm; the Rust toolchain (rustup — the full build prepends `%USERPROFILE%\.cargo\bin` to PATH itself, so cargo does not have to be on the system PATH); MSVC C++ build tools.

### The desktop app is part of the payload (3.0.0+)

Step 6 of the full build compiles `desktop/` and step 8 copies the binary to `build\installer_package\app\owlette-desktop.exe`, which the installer lays down at `{app}\app\owlette-desktop.exe` — the exact path `shared_utils.get_desktop_exe_path()` resolves, so the folder name is a contract with the service, not a preference.

- The build runs **`npx tauri build --no-bundle`**. Inno Setup is this product's packager; letting the Tauri bundler run would demand NSIS/WiX and produce a second installer we do not ship.
- `npm ci` runs **only when `desktop/node_modules` is absent**. `npm ci` deletes `node_modules` before repopulating it, which would pull the tree out from under a dev server or a parallel build on a developer machine.
- The **quick build does not compile it** — it only re-copies `desktop/src-tauri/target/release/owlette-desktop.exe` if one is there, and fails loudly when the package has no desktop app at all (Inno errors on an empty `app\*` source anyway).
- The full build **deletes `claude_agent_sdk/_bundled/claude.exe`** (242 MB) after pip install. It reappears on every clean install, which is why it is scripted; Cortex fetches its own CLI on demand instead.
- The installer probes for the **WebView2 Evergreen runtime** and runs the bundled `vendor\MicrosoftEdgeWebview2Setup.exe` (`/silent /install`) when it is missing — LTSC/IoT kiosk images often lack it, and the app cannot create a window without it. Never fatal; the service works regardless.

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
- **Never drop `AppUserModelID: "app.owlette.desktop"`** from the two `[Icons]` entries that carry it (`{group}\Owlette` and `{userstartup}\Owlette`). Windows silently discards every toast an unpackaged app raises unless a Start-menu shortcut registers its AUMID — the notification API still reports success. The id must stay byte-identical to `tauri.conf.json`'s `identifier` and `startup_link.rs`'s `APP_USER_MODEL_ID`.
- **Never add the AUMID to a third shortcut, and never rename either of those two.** Windows draws a toast's attribution line from the *name* of a registered shortcut and does not specify which it picks when several share an id — that is why `Owlette Configuration` carries no id and why the startup shortcut is `Owlette.lnk`. Both registrars must be named exactly `Owlette` or notifications get attributed to something else.
- **Never let the Tauri bundler run** (`tauri build` without `--no-bundle`) — it wants NSIS/WiX and builds an installer that competes with ours.

---

## Key Files

| File | Purpose | Danger Level |
|------|---------|-------------|
| `owlette_installer.iss` | Inno Setup script — install/uninstall/upgrade logic, WebView2 check | High |
| `build_installer_full.bat` | Downloads Python, pip, deps, NSSM; builds the desktop app; assembles package | Medium |
| `build_installer_quick.bat` | Copies source + desktop exe, compiles installer (fast iteration) | Low |
| `desktop/` | Tauri 2 app — tray icon, config window, reboot prompt (replaced the python UI in 3.0.0) | Medium |
| `agent/vendor/` | Hash-verified third-party binaries shipped with the build (NSSM zip, WebView2 bootstrapper) | Low |
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
| "cargo not found on PATH" | Rust toolchain missing (or installed outside `%USERPROFILE%\.cargo`) | `rustup` install, or put cargo on PATH |
| Quick build fails | No Python runtime in `build/` | Run full build first |
| Quick build: "No desktop app in the installer package" | Never ran a full build, or `desktop/src-tauri/target` was cleaned | Full build, or `cd desktop && npx tauri build --no-bundle` |
| ISCC: "No files found matching ...\app\*" | Same as above — the desktop exe never made it into the package | Same as above |
| Desktop app never opens on a kiosk, service fine | WebView2 runtime absent and the bootstrapper failed | Check `SetupLog` for the `EnsureWebView2Runtime` lines |
| Installer hangs on silent update | `ShouldConfigureSite()` returned true | Check config.json exists at `C:\ProgramData\Owlette\config\` |
| Service won't start after update | Import errors from missing deps | Full rebuild needed |
| Installer flagged by AV | Missing Defender exclusion | Check `Add-MpPreference` step ran |

---

## When This Skill Activates

Working on build scripts, installer config, version management, NSSM setup, or self-update code.
