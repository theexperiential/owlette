# Full-Machine Release E2E Gate — Context

Key facts grounding the plan. Items marked **[verified]** were checked against the code on 2026-06-10; others come from the research pass and should be re-confirmed at implementation time.

## Pairing / auth

- **[verified]** `web/app/api/agent/auth/device-code/authorize/route.ts:57` calls bare `requireSession(request)` — resolves ONLY an iron-session `__session` cookie. A Firebase ID-token bearer will NOT authorize a device code. The `device-code` generate route needs the same cookie so `isDashboardOrigin` sets `preauthorizedIntent=true`; without it the doc takes the interactive branch and authorize 400s.
- The session cookie is httpOnly, encrypted with `SESSION_SECRET`, secure-only in prod. The harness must replay the real login → session-create flow against live dev to obtain it. **MFA is the open question**: sessionManager carries `mfaRequired/mfaVerified` — an MFA-enrolled account has no pure-API login path. Seed a dedicated MFA-free e2e superadmin in dev.
- Pairing phrase expires in **10 minutes** (poll route) — mint immediately before install; retry the mint, never the install.
- `agent/src/configure_site.py` `--add` path (~lines 206-330) polls and receives plaintext tokens for pre-authorized docs — the only fully-headless pairing flow.
- **[verified]** `agent/src/configure_site.py:278` polls via `http_requests.post(...)` with **no custom headers/User-Agent** — Cloudflare 1010-blocks python urllib on this edge (see `reference_prod_api_testing` memory); whether it blocks python-requests' default UA against dev is untested. Wave 0 must test this from the VM.
- **[verified]** `agent/src/auth_manager.py:158` — `machine_id` defaults to `shared_utils.get_hostname()`. Same machineId across snapshot reverts; each `/ADD=` mint creates a NEW `agent_refresh_tokens/{hash}` doc.
- **History (why this gate matters)**: `/ADD=` was broken 2026-03-26 → v2.12.4 (placeholder `pending_<phrase>` machine_id claim → rules 403 on everything; fixed via deferred minting — authorize records `siteId`+`deferTokenMint`, poll mints with the real machineId via claim-lease). A second bug — in-place upgrade silently discarding `/ADD=` — shipped fixed shortly after. **[verified]** current `owlette_installer.iss:235-244`: an explicit `/ADD=` now ALWAYS runs pairing, even over an existing config. The upgrade leg should assert both behaviors: upgrade WITHOUT `/ADD=` skips pairing and preserves tokens; upgrade WITH `/ADD=` re-pairs. Full diagnosis: `dev/add-flow-review/`, memory `project_add_flow_machine_id`.

## Installer

- **[verified]** `agent/owlette_installer.iss:341-357` — if `configure_site.py` exits nonzero, `PairingSucceeded := False`, an MB_OK MsgBox appears (auto-dismissed under `/SUPPRESSMSGBOXES`), service install is **skipped**, and the installer still completes. **Exit 0 ≠ pairing succeeded.** Setup log line `Pairing exit code: <n>` (iss:339) is scrapeable.
- **[verified]** `agent/scripts/install.bat:124` sets `SERVICE_AUTO_START`, `:129` sets `DelayedAutostart=1`, `:174` runs `nssm start OwletteService` — the service is RUNNING when the installer exits. Do not `net start` again; poll `sc query` for RUNNING.
- **[verified]** `agent/owlette_installer.iss:463-527` — upgrade-in-place: existing-install detection, never runs the old uninstaller (previous versions wiped everything), synchronous `net stop` with stopped-state verification that **aborts the upgrade** if the service won't stop, preserves config/auth.
- **[verified]** `agent/owlette_installer.iss` DeinitializeSetup/uninstall (~364-435): silent uninstall **deliberately preserves** config/logs/`.tokens.enc` ("preserving user data for upgrade"). Clean-removal assertions must expect this; only snapshot revert truly empties the machine.
- `/SERVER=dev` targets dev.owlette.app (iss ~196-200). Flags for the gate: `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /SERVER=dev /ADD=<phrase>`.
- UAC secure-desktop prompt cannot be clicked by any in-session UIA tool — launch the installer from an already-elevated process instead.
- Downloaded EXEs carry Mark-of-the-Web → SmartScreen can interpose. `Unblock-File` before launch.

## Agent runtime

- Service runs in Session 0; the tray/GUI launch into the active console session via a three-tier token-cloning fallback (`owlette_service.py` ~1597-1603). No interactive session ⇒ no GUI. GUI launch after autologon is not instant — gate stage 4 on GUI-process-present with skip-vs-fail distinction.
- Heartbeat interval is adaptive (5–120s) — budget 150s+ for first heartbeat.
- Oracles: `service_status.json` (written by `_write_service_status`), `service.log` (`agent_started`, ERROR/CRITICAL scan), dev Firestore `sites/{siteId}/machines/{machineId}` heartbeat, `config/{siteId}/machines/{machineId}` (written by `firebase_client.upload_config`).
- GUI is CustomTkinter — canvas-drawn widgets are **invisible to UIAutomation**. Native dialogs (file-open, message boxes) and the Inno wizard ARE UIA-visible. Process list redraws every 1s; window resizes 270–950px.

## Prior art to reuse

- `dev/video-tutorials/capture-native/recorder.py` — beat()/smooth_move()/slow_type()/move_click()/dump_identifiers() + ffmpeg gdigrab ScreenRecorder.
- `dev/video-tutorials/capture-native/scenes/install_and_pair.py` — pywinauto `Application(backend='uia')` installer-wizard driving skeleton.
- `dev/video-tutorials/capture-native/requirements.txt` — **pywinauto 0.6.9, pywin32==306 (NOT 310+, DLL load failure), psutil 7.2.2**.
- `web/e2e/global-setup.ts` — storageState capture pattern (repoint at dev for the dashboard fixture).
- `web/e2e/helpers/stubAgent.ts` — canonical agent Firestore command-write contract; use as oracle field reference + fallback only.
- `web/e2e/helpers/seed.ts`, `emulator.ts` getAdminDb pattern — admin-SDK accessor for setup/teardown (repoint at dev creds).
- `.github/workflows/build-installer.yml` — semver-tag trigger, signed installer + SLSA provenance to GitHub release; Firebase Storage copy at `agent-installers/versions/{version}/`.

## Cloud-side side effects to neutralize

- Status-ping / health-check crons (cron-job.org, per-env CRON_SECRET) will see the e2e machine appear → heartbeat → vanish every run — the exact false-"machines offline" pattern fixed in 2.12.8. E2e site must have no alert subscribers; teardown before the staleness window.
- Agent Sentry (owlette-agent project) receives events from the e2e VM each run — tag/filter (environment tag or inbound filter) before the first real run.
- Per-run Firestore teardown list: machine doc, config mirror, presence, `agent_refresh_tokens` minted this run (track the hash; sweep by e2e siteId fallback). The upgrade-leg N-1 snapshot's baked-in token is EXCLUDED from the sweep.
