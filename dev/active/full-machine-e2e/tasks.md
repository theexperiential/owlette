# Full-Machine Release E2E Gate — Tasks

Status legend: [ ] not started · [x] done · [~] in progress

## Wave 0 — Auth spike ✅ DONE 2026-07-03 (10/10, `e2e-machine/wave0/RESULTS.md`)

Verdict: **GO.** All three make-or-break unknowns resolved green. Implemented as `e2e-machine/wave0/run_spike.mjs` (+ `poll_agent.py`) rather than the sketch below; the deltas were improvements.

- [x] 0.1 Seed a dedicated e2e **site-owner** (not superadmin — least privilege; `assertUserHasSiteAccess` passes on `site.owner === uid`) in dev with MFA off. (Done per-run + torn down; a persistent runner account for CI is a Wave 4 concern.)
- [x] 0.2 Mint a `__session` cookie headlessly against live dev via Identity Toolkit `signInWithPassword` → `POST /api/auth/session` (capture httpOnly cookie). **MFA does not block a no-MFA account** (session `mfaVerified=true`; `/api/*` is never MFA-gated by the proxy). **Make-or-break — PASSED.**
- [x] 0.3 With the cookie: `POST /api/agent/auth/device-code` (`preauthorizedIntent=true`) then `POST .../authorize {pairPhrase, siteId}` (`deferTokenMint`). Confirmed.
- [x] 0.4 Proved the mint via the agent's real Python + `requests` polling with a **synthetic** machineId (NOT `configure_site.py` — that would clobber this box's live `.tokens.enc`). Oracle: real access+refresh tokens returned, `agent_refresh_tokens` doc created. (Real `.tokens.enc` write + heartbeat doc is a Wave 1 install-run oracle, not needed to prove auth.)
- [x] 0.5 **Cloudflare does NOT block** the agent's default-UA `requests` poll — HTTP 200 on first poll. No dev-edge change needed.
- [x] 0.6 Findings recorded in `e2e-machine/wave0/RESULTS.md`; context.md facts re-verified against current code (all HOLD). **Go decision: proceed to Wave 1.**

## Wave 1 — Fresh-install smoke (no GUI; stages 0–3, 7–8)

**Code built 2026-07-03** as `e2e-machine/wave1/run_wave1.py` + the reusable cloud spine `e2e-machine/lib/` (admin/preauthorize/probe/teardown). Cloud helpers proven against dev; the install/uninstall stages await their **first run on a clean, elevated box** (couldn't run here — this box has a live agent). Run + tuning instructions: `e2e-machine/RUNBOOK.md` Part B.

- [ ] 1.1 Build the golden Win11 image per `docs/internal/gui-automation-machine-setup.md` (Profiles A + C: autologon, no lock/sleep, WU pinned, 100% DPI + fixed res/theme, toolchain, UAC ON), using `scripts/bootstrap-gui-automation.ps1 -Rig E2eRunner` to validate. Record the pinned resolution/theme in that doc so the image is reproducible; the harness README links to it (permanent home in docs/internal/). *(spare box provisioning — user)*
- [x] 1.2 Dedicated e2e site in dev with **zero alert subscribers** — done: `lib/admin.mjs seedSiteAndOwner` seeds `e2e-fullmachine` + a least-privilege owner with all alert prefs OFF, torn down per run. (Sentry env-tag/filter for the e2e machine: still TODO before first heavy use.)
- [x] 1.3 Controller skeleton: per-stage logging + artifact-friendly output + **cloud teardown in `finally`** (`run_wave1.py`). Plain-Python (no pytest dep) so it runs on the bootstrap venv.
- [x] 1.4 Stage 0 preflight: empty-machine asserts (service/dir/registry) + **Session-0 hard-fail** (process-vs-console session, not just WTSGetActiveConsoleSessionId) + elevation check. Verified locally (correctly refused this non-empty, non-elevated box).
- [x] 1.5 Stage 1 pre-auth: `node lib/preauthorize.mjs` mints ≤10 min before install (retry the mint, not the install). Reuses the Wave 0 cookie path. Proven against dev.
- [x] 1.6 Stage 2 install: `Unblock-File` → launch pre-elevated with `/VERYSILENT /SERVER=dev /ADD= /LOG=` → **compound pairing oracle** (service RUNNING + `.tokens.enc` non-empty + config bound to e2e site + setup-log `Pairing exit code: 0`). `--negative` mode proves an invalid phrase FAILS despite installer exit 0. *(awaiting first clean-box run)*
- [x] 1.7 Stage 3 bootstrap oracles: poll RUNNING (no `net start`), `tmp/service_status.json` firebase.connected, `logs/service.log` agent_started + no ERROR/CRITICAL, dev Firestore heartbeat <180s via `node probe.mjs` (200s budget). *(awaiting first clean-box run)*
- [x] 1.8 Stages 7–8: silent uninstall + documented-state asserts (service/binaries/registry gone, user data PRESERVED by design) + cloud teardown. Snapshot revert is the runbook's between-runs step. *(awaiting first clean-box run)*
- [x] 1.9 Chaos safety: teardown + best-effort uninstall run in a `finally`, so a mid-run failure still cleans the box and dev state. (Explicit mid-stage-3 kill test: verify on first real run.)

## Wave 1.5 — Upgrade-in-place leg

- [ ] 1.5.1 Build the N-1 golden snapshot: install + pair current release, verify heartbeat, snapshot. Document the rotation procedure (re-baseline each release or each minor).
- [ ] 1.5.2 Upgrade test: installer N over N-1 → assert upgrade-in-place detected, synchronous service stop reached Stopped, pairing skipped, tokens/config preserved, service back on N, heartbeat resumed.
- [ ] 1.5.3 Exclude the N-1 snapshot's baked-in refresh token from the stage-8 token sweep.
- [ ] 1.5.4 Negative path: wedge the service (hang shutdown) and confirm the installer aborts the upgrade cleanly and the run reports it.
- [ ] 1.5.5 Re-pair-on-upgrade path: upgrade WITH `/ADD=<fresh phrase>` supplied → pairing runs and new tokens replace the old (iss:235-244 explicit-pairing rule, the v2.12.5-era fix); upgrade WITHOUT `/ADD=` skips pairing and preserves tokens (both asserted).

## Wave 2 — GUI tier (highest flake; keep advisory longest)

- [ ] 2.1 Env-gated (`OWLETTE_E2E=1`), read-only tk-introspection shim in the GUI exposing widget rects to a side file. Default-off, unit-tested, no service-file changes (MockService parity not triggered).
- [ ] 2.2 Extract a reusable driver lib from capture-native (recorder.py helpers + install_and_pair.py patterns) into the harness; pin pywinauto 0.6.9 / pywin32==306 / psutil.
- [ ] 2.3 Stage-4 gate: GUI pythonw present in autologon session (skip-vs-fail), then add-process flow (native file dialog via UIA; CTk fields via shim rects; template-match fallback only where introspection can't reach).
- [ ] 2.4 Stage-4 oracles: config doc round-trip to dev Firestore, psutil process under agent management, screenshot artifacts.
- [ ] 2.5 Instrument control-resolution success rates + per-step timing (flake telemetry).

## Wave 3 — Dashboard observation + command loop

- [ ] 3.1 Playwright dev-storageState fixture (global-setup.ts pattern repointed at dev, e2e superadmin).
- [ ] 3.2 Stage 5: machine card online + configured process visible on live dev dashboard; screenshots.
- [ ] 3.3 Stage 6: dispatch restart-process from the dashboard; assert the REAL agent completes (`commands/completed`, pending cleared, PID changed). stubAgent only as documented fallback.

## Wave 4 — CI advisory gate

- [ ] 4.1 Configure the self-hosted runner on the VM **as the interactive autologon user (not a service)**; label it; secrets into the runner store; network-isolate from prod.
- [ ] 4.2 `release-e2e.yml`: triggered off the build-installer tag flow; `concurrency` group; snapshot revert pre/post; artifact resolution by exact version with poll/retry against GitHub release + Firebase Storage, fail closed.
- [ ] 4.3 Full-run wiring (fresh-install leg + upgrade leg), artifact upload, pass/fail surfaced as advisory (non-blocking) on the release.
- [ ] 4.4 Collect flake data over ≥3 releases; per-stage timing dashboard/log.

## Wave 5 — Promote + harden

- [ ] 5.1 Gate the prod promotion/publish step on a green run (not the tag build). Keep GUI tier advisory if its flake rate is still material.
- [ ] 5.2 Interactive-wizard leg (semi-automated, signed installer, visible wizard via install_and_pair.py) as a second matrix entry — documents real UAC/wizard coverage.
- [ ] 5.3 Runner ops runbook: tscon session-preservation, WU pinning, image rebuild procedure, secret rotation.

## Wave 6 — Roadmap (not scheduled)

- [ ] 6.1 Machine-reboot command leg: dispatch reboot → VM goes down → agent auto-starts on boot → heartbeat resumes → reboot-aware offline-alert logic stays quiet (the 2.12.8 regression class). Uniquely testable on a VM.
