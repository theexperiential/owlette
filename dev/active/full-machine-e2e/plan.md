# Full-Machine Release E2E Gate — Plan
**Created**: 2026-06-10 | **Status**: Planned (not started) | **Last revised**: 2026-06-10

## Summary

A full-machine end-to-end test that runs on a dedicated Windows VM for every release: start from an empty machine → silently install the just-built installer → pair headlessly (no human, no browser) → drive the real native GUI to configure a monitored process → observe the machine and process on the live dev dashboard → dispatch a command and assert the real agent completes it → silently uninstall → assert documented clean-removal state → tear down cloud state → revert the VM snapshot. A second first-class leg tests **upgrade-in-place** over a paired N-1 install. The gate complements (does not replace) the fast emulator-based web e2e suite — this is the slow, real-cloud, real-binary release gate.

## Goals

1. Catch install/upgrade/uninstall regressions in the shipped installer artifact before customers do.
2. Exercise the real agent → Firestore → dashboard round-trip with the actual release binary (something no emulator test can do — the shipped agent's REST client cannot reach the emulator).
3. Run unattended on every release tag, advisory first, blocking the prod promotion once flake data justifies it.

**Precedent that motivates this gate**: the `/ADD=` silent-install pairing flow was completely broken for two months (2026-03-26 → v2.12.4: token minted with a placeholder `machine_id` claim, so firestore.rules 403'd every machine-scoped access) and **no existing test layer could have caught it** — the web e2e stubs the authorize route and seeds machine docs via the Admin SDK (bypassing rules), and unit/rules tests hand-fabricate a *matching* claim. Only a real agent with a real token against real rules manifests that class of bug — which is exactly what this gate runs. See `project_add_flow_machine_id` memory + `dev/add-flow-review/`.

## Non-goals / explicit non-coverage (do not over-trust a green run)

- **Browser auto-open pairing flow** (the path single-machine users actually take) — only the `/ADD=` silent path is exercised until Wave 5's interactive leg.
- **Prod edge** — everything targets dev (`/SERVER=dev`, dev Firebase, dev Cloudflare rules). Prod env-var/edge regressions are out of scope.
- **OS matrix** — one Windows 11 image. Win10/Server variants in the fleet are not covered.
- **Replacing the emulator e2e suite** — `e2e.yml` stays as the fast PR gate, untouched.

## Tooling decisions

| Layer | Choice | Why |
|---|---|---|
| Native GUI driver (installer wizard, file dialogs, message boxes, tray) | pywinauto 0.6.9, `backend='uia'`, extracted from `dev/video-tutorials/capture-native/` (recorder.py helpers + install_and_pair.py skeleton) | Already proven against THIS installer and GUI. **Pin `pywin32==306`** — 310+ fails `DLL load failed` on embedded Py3.9/Win11. |
| CustomTkinter widgets (process list, CTkEntry/CTkOptionMenu) | Env-gated (`OWLETTE_E2E=1`), read-only tk-introspection shim in the GUI process exposing `winfo_*` widget rects to a side file; click via `pywinauto.mouse`; template-match fallback; raw coords last resort | CTk widgets are canvas-drawn and **invisible to UIAutomation**. The shim is the minimal reversible alternative to blind clicking (process list redraws every 1s; window resizes 270–950px). Shim must be default-off and unit-tested so it can't regress prod. |
| pyautogui | Not used as a driver; only the screenshot/template-match dependency if needed | Blind coordinate clicking — brittle to DPI/position/theme. Rejected as primary. |
| Headless pairing | Mint a `__session` cookie for a dedicated **MFA-free e2e superadmin** against live dev (replay the real login → session-create flow), then `POST /api/agent/auth/device-code` + `POST .../authorize` with that cookie, then install with `/VERYSILENT /SERVER=dev /ADD=<phrase>` | `authorize/route.ts:57` calls bare `requireSession()` — **cookie only, a Firebase bearer token will NOT work**, and `device-code` needs the same cookie for `preauthorizedIntent=true`. Phrase expires in 10 min — mint immediately before install; on expiry retry the mint, not the install. |
| Backend | Real **dev** Firebase project, dedicated e2e `siteId`, mandatory per-run teardown | Shipped agent cannot reach the emulator. Isolated site avoids polluting dev fleet data. |
| Dashboard observe/command | Playwright vs live dev.owlette.app, storageState fixture (global-setup.ts pattern repointed at dev) | Reuses existing e2e auth capture pattern. `stubAgent.ts` field contracts reused as **oracles only** — the real agent completes commands here. |
| Orchestrator | Single Python pytest controller in the interactive session; Playwright invoked as a subprocess for the dashboard slice; structured per-stage JSON + artifacts | One runtime for install/GUI/oracle tiers; per-stage pass/fail granularity. |

## Lifecycle stages and oracles

| # | Stage | Key oracle (never trust a single signal) |
|---|---|---|
| 0 | Snapshot revert + empty-machine preflight | `sc query OwletteService` → 1060; `C:\ProgramData\Owlette` absent; uninstall registry key absent. Hard-fail if not clean. Also hard-fail if `WTSGetActiveConsoleSessionId()` is 0xFFFFFFFF (runner misconfigured as a service → no desktop → GUI tier silently impossible). |
| 1 | Mint `__session` cookie + pairing phrase (headless, ≤10 min before install) | device-code doc in dev Firestore is pre-authorized for the e2e siteId; authorize returns 200. |
| 2 | Download installer, `Unblock-File` (MotW), launch `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /SERVER=dev /ADD=<phrase>` **from an already-elevated process** | **Installer exit 0 is NOT a pairing oracle**: on pairing failure the installer suppresses the MsgBox, skips service install, and still completes (iss:341-357). Assert ALL of: service registered AND RUNNING, `.tokens.enc` present and non-empty, `config.json` has the e2e site_id, Inno setup log contains `Pairing exit code: 0`. |
| 3 | Agent bootstrap + first heartbeat | Service auto-starts at install (`install.bat:124,174` — do NOT `net start` again; poll for RUNNING). `service_status.json` `firebase.connected==true`; `agent_started` in service.log with no ERROR/CRITICAL; dev Firestore machine heartbeat. **Budget 150s+** (adaptive 5–120s heartbeat interval). |
| 4 | GUI tier: add a monitored process (e.g. notepad.exe) via the real GUI | Config doc updated in dev Firestore (`upload_config`); process running under agent management (psutil); GUI status dot. Gate on "GUI pythonw present in the autologon session" first with skip-vs-fail distinction — the Session-0 → console-session GUI launch is a three-tier fallback that may still be mid-launch after autologon. |
| 5 | Dashboard observation (Playwright vs dev) | Machine card online; configured process visible; screenshot artifact. |
| 6 | Command round-trip (dispatch from dashboard) | Real agent writes `commands/completed`, pending cleared, target process PID changed (psutil), service.log shows handling. stubAgent completion is a fallback only for commands impractical on a bare VM. |
| 7 | Silent uninstall (`unins000.exe /VERYSILENT /SUPPRESSMSGBOXES`) | Exit 0; service removed (1060); binaries/registry gone; **config/logs/.tokens.enc still present** — silent uninstall deliberately preserves user data (iss DeinitializeSetup); assert the documented behavior, don't flag it as a leak. |
| 8 | Cloud teardown (**in `finally` — must run even on mid-run failure**) + artifact upload + snapshot revert | Machine doc, config mirror, presence, and the `agent_refresh_tokens` doc(s) minted this run deleted from dev Firestore (track the minted token hash; sweep by e2e siteId as fallback). Revert happens last — it cannot reach the cloud. |

### Upgrade leg (Wave 1.5 — first-class, not an afterthought)

Second golden snapshot with **version N-1 installed and paired**. Run installer N over it and assert: existing-install detected → upgrade-in-place (no old-uninstaller run), synchronous `net stop` reached Stopped (the installer aborts if not — iss:463-527), pairing skipped (`PairingSucceeded` assumed true on valid config), tokens/config preserved, service back on version N, heartbeat resumed. The N-1 snapshot's baked-in refresh token must be **excluded** from the stage-8 token sweep and refreshed (re-snapshotted) only when deliberately rotating the baseline.

## Infrastructure

- Dedicated Windows 11 Pro VM (Hyper-V on a spare host), network-isolated from anything that can reach prod, acting as a **self-hosted GitHub Actions runner configured to run as the autologon interactive user — NOT as a service** (a service runner lives in Session 0: no desktop, no GUI to drive, and the failure is silent).
- **Golden image recipe** (documented + reproducible): autologon; screen lock/screensaver/sleep/hibernate disabled; Windows Update deferred/pinned; **100% DPI scaling, fixed resolution, fixed theme** (template matching and geometry clicks are sensitive to all three); toolchain pre-provisioned (Python venv: pywinauto 0.6.9, pywin32==306, psutil; Node + Playwright + chromium; curl); UAC **left on** — the installer is launched from an already-elevated process instead (no `EnableLUA=0`, ever; `ConsentPromptBehaviorAdmin=0` only as a last resort). **The runnable provisioning checklist is `docs/internal/gui-automation-machine-setup.md` (canonical, shared with the capture rig — Profiles A + C), with `scripts/bootstrap-gui-automation.ps1` as its executable form.**
- Secrets (dev login creds for the e2e superadmin, autologon password, Firebase admin credentials) live in the runner's secret store, never baked into the image.
- Never RDP-disconnect carelessly — it locks the desktop and kills UIAutomation; use `tscon` to return the session to console.
- State reset is **snapshot revert**, not uninstall-cleanup (silent uninstall preserves user data by design, so the machine is never truly empty again without a revert).

## Cloud-side hygiene (do before the first real run)

- **machineId defaults to the hostname** (`auth_manager.py:158`), so every reverted run reuses the same machine doc and mints a new `agent_refresh_tokens` doc. Decision: keep the stable hostname and scope assertions to "doc exists + heartbeat fresh" (not "doc was created"); mandatory teardown handles accumulation.
- **The e2e site must have zero alert subscribers** (or an explicit exclusion): each run manufactures a machine that heartbeats and then vanishes — exactly the false-"machines offline" pattern fixed in 2.12.8. Teardown must delete the machine doc before the status-ping/health-check cron staleness window notices it.
- **Sentry**: the e2e VM's agent reports to owlette-agent every run; tag or filter its events (environment tag or inbound filter) so uninstall-window noise doesn't pollute alerting.

## CI integration

- Attach to the existing release trigger: `build-installer.yml` fires on semver tag push and publishes the signed installer. New `release-e2e.yml` job on the self-hosted runner with `needs:` on build/release.
- **Resolve the artifact by exact version with a poll/retry loop** against both the GitHub release asset and the Firebase Storage copy (`agent-installers/versions/{version}/`); fail closed on timeout. Signing + provenance can lag the tag.
- **`concurrency` group from day one** — two quick successive tags must not interleave on the one VM and one e2e site.
- Blocking semantics: a tag has already built by the time the gate runs, so **block the prod promotion/publish step, not the tag build**. Advisory until flake data justifies promotion (Wave 5).
- Artifacts per run: per-stage JSON, service.log, service_status.json, Inno setup log, Playwright screenshots/traces, GUI screen recording (reuse the ffmpeg gdigrab ScreenRecorder from capture-native).

## Success criteria

1. Wave 0 spike proves a `__session` cookie + pairing phrase can be minted fully headlessly and `configure_site.py --add` authenticates against live dev from the VM (tokens in `.tokens.enc`, machine doc + heartbeat in dev Firestore) — with MFA and Cloudflare confirmed non-blocking.
2. Fresh-install leg passes end-to-end unattended (stages 0–3, 7–8) with the compound pairing oracle — a deliberately-broken pairing (expired phrase) is correctly detected as FAILURE despite installer exit 0.
3. Upgrade leg passes: N over paired N-1 preserves auth/config and comes back heartbeating on N.
4. GUI leg adds a process through real clicks and the config round-trips to dev Firestore.
5. Dashboard leg observes the machine/process and a dispatched command completes by the real agent.
6. A mid-run failure still tears down cloud state (finally semantics) and the next run's preflight passes.
7. Gate runs automatically on a release tag, advisory, with artifacts; flake rate measured over ≥3 releases before any blocking decision.

## Risks

1. **MFA blocks headless login for the e2e superadmin** — make-or-break; tested first in Wave 0 (seed MFA-free dedicated account; backup-code path as fallback).
2. **Cloudflare 1010-blocks the agent's own `requests` poll** (configure_site.py:278 sends no custom UA) — tested in Wave 0 against live dev from the VM; mitigations: dev-edge allowlist for runner egress IP, relax bot-fight for `/api/agent/*` on dev, or add a UA to the poll.
3. **GUI tier flake** (CTk canvas, 1s list redraws, Session-0 GUI-launch timing) — highest-maintenance tier; phased last, kept advisory longest, skip-vs-fail gated.
4. **Runner is a standing liability** (autologon, no lock, holds dev creds) — network-isolated, disposable, treated as compromised-by-design; Windows Update pinned; preflight hard-fails on misconfiguration.
5. **Introspection shim regresses prod GUI** — read-only, env-gated default-off, unit-tested, reviewed as agent code (MockService parity rules apply if any service file is touched).
6. **Artifact timing race** — poll/retry with fail-closed timeout (see CI integration).

## Wave structure

See `tasks.md`. Wave 0 is a half-day spike that validates or kills the riskiest assumptions before any harness code is written. Waves: 0 (auth spike) → 1 (fresh-install smoke, no GUI) → 1.5 (upgrade leg) → 2 (GUI tier) → 3 (dashboard + command loop) → 4 (CI advisory gate) → 5 (blocking + interactive-wizard leg) → 6 (roadmap: reboot-command leg — uniquely VM-testable, exercises the reboot-aware offline-alert logic from 2.12.8).

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-10 | pywinauto/UIA primary; pyautogui rejected as driver | Control identity beats blind coordinates; prior art in capture-native already proven against this installer/GUI. |
| 2026-06-10 | Real dev Firebase, not emulator | Shipped agent's REST client cannot reach the emulator; the round-trip IS the value of the gate. |
| 2026-06-10 | Headless auth via `__session` cookie fixture + `/ADD=` | `requireSession` is cookie-only (authorize/route.ts:57); `/ADD=` is the only fully-headless pairing path. |
| 2026-06-10 | UAC stays ON; installer launched pre-elevated | `EnableLUA=0` makes the image unlike any customer machine; pre-elevation needs no posture change. |
| 2026-06-10 | Snapshot revert is the state reset; cloud teardown mandatory in `finally` | Silent uninstall preserves user data by design; revert can't reach Firestore, so teardown precedes it. |
| 2026-06-10 | Stable hostname kept; assertions scoped to "exists + fresh", not "created" | machineId == hostname across reverts; randomizing hostnames buys little and complicates the image. |
| 2026-06-10 | Upgrade-in-place is a first-class leg (Wave 1.5) | iss:463-527 is bespoke, timing-sensitive, regression-prone logic; fleet upgrades are the most common real operation. |
| 2026-06-10 | Gate blocks prod promotion, not the tag build | The tag has already built/signed by gate time; gating promotion avoids the chicken-and-egg. |
| 2026-06-10 | Installer exit code never trusted as pairing oracle | Pairing failure is swallowed non-fatally for bulk-deploy UX (iss:341-357); compound oracle required. |
| 2026-06-10 | Emulator e2e suite untouched and complementary | Fast PR gate vs slow release gate — different jobs. |
