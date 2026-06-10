# Full-Machine Release E2E Gate — Tasks

Status legend: [ ] not started · [x] done · [~] in progress

## Wave 0 — Auth spike (half-day; validates or kills the riskiest assumptions before any harness code)

- [ ] 0.1 Seed a dedicated e2e superadmin in the dev Firebase project with MFA disabled (or a backup-code path a script can drive). Store creds in the runner/host secret store.
- [ ] 0.2 Script minting a `__session` cookie headlessly against live dev (replay login → session-create; capture the httpOnly cookie). Confirm MFA does not block. **Make-or-break.**
- [ ] 0.3 With the cookie: `POST /api/agent/auth/device-code` (expect `preauthorizedIntent=true`) then `POST .../authorize` with the e2e siteId. Confirm 200 + pre-authorized doc.
- [ ] 0.4 On the spare machine, run `configure_site.py --add <phrase> --url https://dev.owlette.app/api` directly (no installer). Oracle: tokens in `.tokens.enc`, machine doc + heartbeat in dev Firestore, `agent_refresh_tokens` doc created.
- [ ] 0.5 Confirm Cloudflare does NOT 1010-block the agent's `requests` poll from the VM. If blocked: dev-edge allowlist / bot-fight relax for `/api/agent/*` / add UA to the poll — pick and document.
- [ ] 0.6 Record findings in context.md; go/no-go decision for the harness.

## Wave 1 — Fresh-install smoke (no GUI; stages 0–3, 7–8)

- [ ] 1.1 Build the golden Win11 image per `machine-setup.md` (Profiles A + C: autologon, no lock/sleep, WU pinned, 100% DPI + fixed res/theme, toolchain, UAC ON). Record the pinned resolution/theme in machine-setup.md so the image is reproducible. When the harness directory is created, promote machine-setup.md to its README (leave a pointer).
- [ ] 1.2 Create the dedicated e2e site in dev; confirm zero alert subscribers; decide + apply the Sentry tag/filter for the e2e machine.
- [ ] 1.3 Pytest controller skeleton: per-stage JSON logging, artifact collection, **cloud teardown in `finally`**.
- [ ] 1.4 Stage 0 preflight (empty-machine asserts + interactive-session hard-fail via `WTSGetActiveConsoleSessionId`).
- [ ] 1.5 Stage 1 pre-auth (Wave 0 scripts productionized; mint ≤10 min before install, retry mint not install).
- [ ] 1.6 Stage 2 install: download → `Unblock-File` → launch pre-elevated → **compound pairing oracle** (service RUNNING + `.tokens.enc` non-empty + config site_id + setup-log `Pairing exit code: 0`). Negative test: expired phrase must FAIL the run despite installer exit 0.
- [ ] 1.7 Stage 3 bootstrap oracles (poll RUNNING — no `net start`; service_status.json; log scan; Firestore heartbeat, 150s+ budget).
- [ ] 1.8 Stages 7–8: silent uninstall + documented-state asserts (binaries/service/registry gone, user data PRESERVED) + cloud teardown + snapshot revert; verify next-run preflight passes.
- [ ] 1.9 Chaos check: kill the controller mid-run at stage 3; confirm teardown still ran and the next run is clean.

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
