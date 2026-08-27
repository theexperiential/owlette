# drift audit — 2026-08-25 (scripts @ 2549f82 / 2026-05-25 vs product 3.2.0)

17-agent audit (13 per-episode fact-checkers + feature-gap + capture-infra + voiceover
agents + a completeness critic), every finding verified against current code with
file:line evidence. ~320 commits landed since the scripts were written (2.12.x → 3.2.0).
Findings were checked against origin/dev and origin/main; **local checkout was 17
commits behind origin/dev at audit time** — pull before acting on file:line cites.

## Bottom line

| # | Episode | Verdict | Beats | Re-voice | Notes |
|---|---|---|---|---|---|
| 1 | what is owlette? | touch-up | 5 | 1 | color-ramp line; b-roll cortex→hoot frame |
| 2 | install & pair | **partial-rewrite** | 9 | 2 | pairing moved console → desktop-app window (3.1.0) |
| 3 | dashboard tour | touch-up | 6 | 3 | nav is 6 items now (hoot, talons); ram/tile order |
| 4 | keep a process alive | touch-up | 7 | 1 | "reboot pending" → "restart pending" |
| 5 | run on a schedule | touch-up | 6 | 1 | b06 inverted: desktop app EDITS schedules now |
| 6 | reading machine health | touch-up | 7 | 0 | best-preserved episode; screen-only fixes |
| 7 | remote actions | touch-up | 7 | 3 | reboot→restart copy; members get screenshot/live view |
| 8 | tray & local gui | **full-rewrite** | 6 | 6 | Tkinter GUI deleted in 3.0.0 → Tauri desktop app |
| 9 | deploy software | touch-up | 7 | 1 | May blocker FIXED (auto-sha256); retry is in-place now |
| 10 | roost | **ok** | 6 | 0 | zero script changes; scene has a 1-line bug |
| 11 | team & alerts | touch-up | 6 | 1 | role-card product bug; talons handoff missing |
| 12 | cortex → hoot | **partial-rewrite** | 6 | 6 | rename + tier-3 gate beat is inverted |
| 13 | logs & troubleshooting | touch-up | 6 | 1 | b06 teaches clear-scoping backwards |

**Re-voice: 26 of 84 beats.** 58 MP3s survive untouched (per-beat pipeline payoff).
All 84 MP3s + manifests exist locally at `voiceover/out/` (gitignored — this machine only).
Re-capture: all 11 web scenes should re-run anyway (app-wide restyle since May) — that's
near-free once the scene fixes below land. The expensive re-shoots are native: ep02's
install segment, all of ep08, and ep05's b06 b-roll.

---

## The three structural breaks

### ep02 — install & pair (partial-rewrite)
3.1.0 moved pairing out of the console into the desktop app: the installer hands off to
`owlette-desktop.exe --pair` (owlette_installer.iss:841-857); the phrase renders in the
app's "join a site" dialog (click-to-copy); the console branch survives only for `/ADD=`
or missing WebView2. **b06 is gone outright**: the "open browser? [y/N]" prompt and
`/OPENBROWSER=` were deleted — nothing on a target machine opens a browser by itself;
the replacement is an "open {host}/add" button in the pairing window. b04's "three
things" undersells (also installs the Tauri app, the Rust owlette-host, conditionally
WebView2 + the PawnIO driver; retracts legacy Defender exclusions). **Good news:** the
b09 silent-install claim is now TRUE — the `/ADD=` 403 (placeholder machine_id) was
fixed (deferred token mint, poll/route.ts:192-214); that beat needs no change. New
recovery beat available: service installs even if pairing fails; pair later from Start
menu → "join site".

### ep08 — the local app (full-rewrite)
Premise deleted: no owlette_gui.py / owlette_tray.py exist; surface is the Tauri app.
All 6 MP3s dead. Worst inversion: b04 says schedules are read-only locally — the app
ships a full schedule editor in every launch mode. Other breaks: tray icon is an amber
owl eye (not "a dot in a circle"); menu is open owlette / restart service / start on
login / exit; context menu lost move up/down, gained duplicate (reorder = row drag);
footer is one sentence + conditional start-service/join-site button; leave-site lives in
the hamburger menu. Unmentioned features worth beats: drag-and-drop process creation
(drop classifier: .toe→TouchDesigner, etc.), in-app pairing, auto-save (no save button),
advanced disclosure (priority/visibility), tray toasts + flashing red icon, reboot
countdown prompt. Episode title/slug "tray & local gui" is itself stale → "the owlette
app on the machine".

### ep12 — hoot (partial-rewrite)
All six beats say "cortex"; rename is total in the UI (routes /hoot, nav, settings
section, power toggle "hoot active"). **b05 is inverted**: the script's PRODUCT-GAP note
("tier-3 gate unimplemented, tools auto-run") became false one day after the script was
written — the approve/deny card shipped 2026-05-25, default-on per site
(hoot-utils.server.ts:387-406; ToolCallCard.tsx:128-158). b03's "same conversation,
different scope" was never true (target switch = new conversation). New beats worth
adding: async turns (close the tab mid-tool, come back, result is there — the strongest
demo the episode has), per-user LLM key in account settings (site-level key scope
removed), per-machine kill switch + third guardrail (approval toggle), autonomous
investigations. **Slug decision: keep file/slug `12-cortex` (wire name), change the
title/display copy to hoot** — renaming the slug orphans `out/12-cortex/` and the scene
id; this mirrors the product's own UI-says-hoot / wire-says-cortex convention.

---

## Touch-up highlights (full detail in the audit JSONs)

- **ep01**: "green up toward red" mis-describes the 5-band emerald/violet/sky/amber/red
  accent ramp (pre-existing error, never matched the UI). b-roll frame: hoot not cortex.
  Coverage gap: overview never mentions hoot, talons, roost, or displays.
- **ep03**: nav beat must enumerate 6 destinations (dashboard, hoot, talons, roost,
  deploy, logs); tile label is "ram", gpu/disk transposed, network tile + displays-above-
  processes order; "just-restarted cards" visual was never built (fixture writes a field
  nothing reads).
- **ep04**: banner copy is "restart pending" (UI renamed 9b8b52fd; wire keeps reboot —
  deliberate); lowercase launch-mode labels; row gained duplicate + schedule gear;
  controls are not hover-revealed. Missing: attempts 0 = unlimited; stalled/hang
  detection.
- **ep05**: b06 inverted — desktop app edits schedules, local edits sync ~1s (3.0.2);
  true web-only advantage is presets. Schedule editable from every launch mode now.
  **Critic: site TIMEZONE is never taught** — schedules evaluate in the SITE's timezone
  (default UTC at creation); one sentence here + a beat wherever site creation lands.
- **ep06**: cleanest episode. b04 must film the COLLAPSED stats row (latency/loss chips
  live only there; expanded network tile is throughput-only) with a degraded-machine
  seed. Add: temps can be blank without PawnIO driver / disabled in config; offline = 5
  missed minutes.
- **ep07**: reboot→restart copy in b04/b05 (+ title/H1); b07 permission story changed —
  members get screenshot + live view (MACHINE_VIEW, 2.12.8); restart schedulable while
  offline; menu gained "view displays". **Product bug: "revoke token" renders for site
  admins but the route is superadmin-only → 403** (fix before filming b07, or three-state
  the graphic).
- **ep09**: unblocked — dialog auto-computes sha256 (ae7ce6c2), agent-side refusal now
  satisfied; retry is IN-PLACE (no "(Retry)" clone) + per-machine retry arrow (b07
  re-voice). Missing: remote uninstall, "update owlette" fleet self-update on this page.
- **ep10**: zero script changes (least-drifted surface). Scene bug: deep-link + click
  toggles the panel OFF — delete the click (a56788db fixed deep links); ep10 has never
  captured cleanly (1.9MB mp4 vs 16-22MB). Production call: "developer preview" badge
  is in frame for b01. Missing coverage worth beats: re-sync targets, editing targets
  after creation, publish-without-distribute, minimized upload.
- **ep11**: b03's spoken role split is correct but the member role card copy contradicts
  it on camera — **product bug: fix ROLE_DESCRIPTIONS.member (page.tsx:43) first**.
  Admin list omits talons authoring (TALON_MANAGE). b06: "hoot escalation alerts" + new
  "talon alerts" toggle (screen-only). Add: superadmin reset-2FA row action; talons
  handoff (site admins author automation without superadmin). Critic: show the actual
  alert email once (~15s).
- **ep13**: b06 teaches clear-scoping backwards — the dialog's own from/to pickers DO
  scope deletion (landed 38 min before the script was committed); page view-filter dates
  and search still don't. Add talon_* events to the filter walkthrough. Critic: close
  the series at docs + the desktop app's "report issue" (auto-attaches diagnostics).
  Product bugs: filter offers "scheduled_reboot" which nothing emits; "clear logs"
  button renders for members who lack the capability.

---

## Coverage gaps → proposed new episodes

Shipped, nav-level, zero coverage (full sketches in the gap agent's output):

1. **talons: rules that watch and act** — the largest gap. trigger → condition →
   outputs, 5 built-in presets, AI visual check, "let hoot act" tier-2 opt-in, run
   history + auto-disable, "update guard" preset as the closer. Also closes the loop on
   eps 4-7.
2. **day zero: sign up, 2fa, and your first site** — critic upgraded this from an
   account-security episode: nothing covers sign up → mandatory 2FA (3.1.0 blocks the
   dashboard until enrolled) → create your first site ("step 1" of the dashboard's own
   empty state; self-serve creation works since 3.0.0) → set its timezone. ep02 assumes
   a site exists; this episode should precede it. Include passkeys, backup codes,
   trust-this-device, superadmin reset.
3. **display layouts: capture a wall, put it back** — promote from "optional add-on":
   display alerts deliver again, auto-restore unbroken, talons has display triggers.
   Caveat: identity is still port/cable-derived (identity-v2 NOT shipped) — don't
   promise re-cable-proof recognition.
4. **keeping the fleet current** (optional, cut first): dashboard agent updates (3.0.0
   is a hard cutover), agent-tokens admin, precise vs hostname-wide revoke, retiring a
   machine. Fold the revoke beat into ep11 if not made.

Proposed order: 1 overview → 2 day-zero → 3 install & pair → 4 dashboard tour → … →
talons after remote actions (or after the local-app episode) → display layouts + fleet
maintenance in the power batch. Renumbering ripples through filenames, `out/` folders,
and scene ids — do it once, at rewrite time, with a rename map.

**Verified-negative (do NOT script):** billing/trial/paywalls — removed end to end in
3.0.0, landing still says "free during beta", plan gated on user go-live; any pricing
line is wrong today and ep01's framing must be re-checked at T0. Developer surfaces
(API keys UI, CLI, SDK) stay excluded; webhooks get a mention only as a talons output.

---

## Capture infrastructure

**Web harness: healthy.** All 11 scenes + helpers + ffmpeg recorder current; `npm run
videos` works; ep12's scene was already ported to hoot. Fix: `web/e2e/videos/README.md`
was never updated after the ffmpeg rewrite (claims .webm/recordVideo/one-scene — all
false; omits ffmpeg+NVENC+interactive-desktop prereqs). Code nit: `buildFallbackFfmpegArgs`
(non-NVENC path) is written but never called — non-NVIDIA boxes hard-fail.

**Per-scene fixes before re-running** (each verified in the audit):
- ep03: Escape never closes the metrics panel (no key handler — add testid to the close
  button); fixture seeds ZERO processes (stat tile reads 0 under narration about
  processes); drop the "just-restarted" framing.
- ep04: seed `metrics.processes` LAUNCHING→RUNNING after create (rows render from the
  agent-written doc; none exists in the emulator).
- ep05: gear locator can't resolve (icon-only button, tooltip doesn't name it); Escape
  closes the whole dialog (click the inline X); "06:00" resolves to 6 pm under the
  seeded 12h pref (type "6am").
- ep06: film b04 against the collapsed stats row + degraded seed; add per-device history
  to media-server-stage so b06's tabs have variety.
- ep07: add a testid to the schedule-restarts gear; account for the new "view displays"
  item; one unforced click contradicts the scene's own tooltip-intercept rule.
- ep09: use the manual-checksum path (server can't reach the installer URL from the
  emulator); seed system presets + templates (dropdown otherwise empty); pick targets
  before opening close-processes; drop the fabricated 'scheduled' status row.
- ep10: delete the toggle-off click (one line).
- ep11: fix stale alertRules header comment (schema is talons now); scope the bare
  getByRole('dialog'); re-shoot only after the member-card copy fix lands.
- ep12: delete the stale "gate unimplemented" header; seed an approval-requested tool
  part so b05 can film the approve/deny card; scope the toolCard selector; make b06's
  target-switch (which empties the chat) an intentional framing choice.
- ep13: bump seeded "version 3.0.0" strings; use real event names (scheduled_reboot_*);
  frame the clear dialog's date pickers; re-time b06 narrate() budgets after re-voice.

**Native harness: half-broken, strategy settled.**
- *Installer wizard*: pywinauto spine still works (Next/Next/Install vs the 3.2.0
  wizard verified). Rewrite `install_and_pair.py`'s premise: the wizard no longer blocks
  on a pairing console (hands off to the app with ewNoWait and reaches Finish); size the
  install dwell for WebView2 + PawnIO + service install (minutes, not 8s); run from an
  elevated shell; Unblock-File the exe. VM state determines which progress captions
  appear — decide and note it.
- *Desktop app + pairing dialog*: **do NOT pywinauto/tauri-driver the window.** Extend
  the existing `web/e2e/desktop-screenshots/` harness — it already drives the installed
  exe over WebView2 CDP (`--remote-debugging-port` + connectOverCDP) with PROGRAMDATA/
  COMPUTERNAME redirected to fixture trees, layout.json pinned, the live tray killed by
  PID, and a `configure_site.py` stub that yields a deterministic pairing phrase with no
  real device code burned. Build the video sibling: CDP driving + the existing ffmpeg
  recorder (CaptureRegion is already parameterized) + ported fake-cursor/narrate
  helpers. tauri-driver is unworkable (single-instance forwards argv and exits);
  UIA-over-WebView2 exposes Tailwind classes, not names (repo already rejected it).
- *Tray icon/menu*: keep pywinauto/UIA + the existing capture-tray-menu.ps1 (preserve
  its two hard-won rules: single UIA lookup ~1.2s after the click, PrintWindow with
  PW_RENDERFULLCONTENT).
- *Retire*: e2e-machine/wave2 `gui_driver.py` + the OWLETTE_E2E widget-rect shim (CTk is
  gone; CDP obsoletes the concept). native-capture-pipeline PLAN.md's recorder half
  stays sound; its automation half needs the CTk locators deleted.
- *Rig*: none exists (full-machine-e2e task 1.1 "spare box" still unchecked — user).
  This workstation can capture (ffmpeg + RTX 2080 Ti verified). The machine-prep doc
  (docs/internal/gui-automation-machine-setup.md) + bootstrap-gui-automation.ps1 are
  current — keep as-is.
- *Live-demo hazard (critic)*: hoot's machine-side tools fetch a 241.5 MB Claude CLI on
  first use (3.0.0 unbundled it; backoff on failure) — a freshly paired demo machine
  can't run hoot tools / talons "let hoot act" until the fetch completes. Pre-warm
  before any live hoot/talons take; consider one honest line in ep12.

## Voiceover pipeline (fix BEFORE any re-render)

Parser contract verified clean (84/84 beats reparse byte-identical to manifests).
Production settings recovered forensically: eleven_v3, stability **0.30**, style 0.0,
the personal PVC voice (id in `voiceover/.env` only — public repo, never commit it),
mp3_44100_128 (md5-matched against the s30 sweep folder).
Gaps, in order:
1. **HIGH** — stability/style are not persisted anywhere and `--stability` defaults to
   0.5: the documented `--only-beat` command verbatim produces an audibly mismatched
   beat. Write settings into manifest.json; default from the existing manifest.
2. **HIGH** — no changed-only/skip-existing mode: re-running an episode re-synthesizes
   every beat, replacing approved takes. Add `--changed` driven by the manifest text
   diff (the mechanism already proves out — drift is currently zero).
3. **MED** — `--only-beat` takes one id; make it repeatable.
4. **MED** — `--only-beat` + `--all` applies the beat id across all 13 episodes; guard.
5. Slug rename orphans audio (`out_name` derives from slug) — keep `12-cortex`.
6. Docs: README/env.example still call multilingual_v2 the default (all 13 shipped on
   v3 — a follower would silently strip the audio tags); pin `model: eleven_v3` in
   front matter and record voice id + stability 0.30 in the README. **Nothing in git
   records the production voice settings today — the series is unreproducible if out/
   or .env is lost. Back up `voiceover/out/` off-machine.**

## Product bugs surfaced by this audit (triage separately; scripts describe actual behavior)

1. Member role card says members "dispatch commands" — contradicts capabilities.ts
   (web/app/admin/users/page.tsx:43). Blocks filming ep11 b03.
   **FIXED e0c8341a (2026-08-25)** — all three cards rewritten against the matrix.
2. "revoke token" menu item renders for site admins; route requires superadmin → 403 on
   click (MachineContextMenu.tsx:354-367 vs revoke/route.ts:40). Affects ep07 b07.
   **FIXED e0c8341a** — route moved to a new site-scoped AGENT_TOKEN_REVOKE capability
   (granted to site admins; strict subset of MACHINE_REMOVE); round-trip e2e with a
   verified 403→200 negative control.
3. "clear logs" button renders for members who lack SITE_LOGS_MANAGE → error-on-click
   (ep13). **FIXED e0c8341a** — hidden behind isSiteAdmin; access-control spec added.
4. Logs action-type filter offers "scheduled_reboot", which nothing emits; the agent's
   actual scheduled_reboot_*/process_restarted events aren't selectable (ep13).
   **FIXED e0c8341a** — grouped list of 46 emitter-verified options.
5. `lastRebootCompletedAt` is seeded by fixtures but read by nothing — the "just
   restarted" chip was never built (ep03). **FIXED 10bb80a5** — dead field + camera
   direction removed; building the chip for real = agent-release feature, backlog.
6. ffmpeg-recorder's written non-NVENC fallback is never invoked (web harness).
   **FIXED 10bb80a5** — retry wiring + OWLETTE_VIDEO_CAPTURE_PATH pin + jest coverage
   (negative control recorded); also fixed the orphan-on-timeout and unhandled-ENOENT
   defects found during wiring.
7. roost page ships a "developer preview" badge — in frame for ep10 b01 (decision, not
   defect). **DECIDED (user, 2026-08-25): REMOVED** — badge + empty-state caveat deleted
   per the investigation's recommendation; the /settings/webhooks banner stays (accurate,
   correctly scoped to the one open gap). — investigation (2026-08-25) recommends removal:
   the badge's premise (site-tier gate) was deleted with billing, cancel + resume are
   fixed, and the one open gap (auto webhook dispatch) is already disclosed on the
   webhooks page. Bonus finding filed from that investigation:
   sync_state.list_pending_distributions() has no production caller — interrupted
   syncs resume only on server re-dispatch, not at agent startup.
8. **NEW (rewrite wave, 2026-08-25): the schedule editor asserts site-time evaluation
   the agent does not perform.** The dialog shows a timezone chip labelled `source="site"`
   (ScheduleEditor.tsx:493-496) and evaluates its own outside-window banner in the site
   timezone (:663), but the agent evaluates every window machine-local:
   `_cached_site_timezone` is never populated in production — the site lookup is
   "name-only by design … which is deferred" (firebase_client.py:431-433) and the
   Firestore fallback 403s under agent tokens (:476-478). A site whose timezone differs
   from a machine's clock gets a banner/chip that lies about when the window fires.
   **Needs a product decision**: wire site-time evaluation (return `timezone` from
   /api/agent/site + drop the name-only guard — the agent plumbing is already in place)
   or relabel the chip/banner as machine-local. The original audit critic's "schedules
   run on the SITE's timezone" claim was wrong about effective behavior; both scripts
   that touched it (ep02 day-zero, ep06 schedules) now narrate only what ships.
   Caught by the touchup:B reviewer; adjudicated in code.
9. **NEW (capture validation, 2026-08-26): the bootstrap challenge gates calls, not
   creation — dead recovery path for password accounts.** Every prod email/password
   signup races two bootstraps: signUp's tokened call (200) and the auth listener's
   tokenless call (AuthContext.tsx:502 passes no token; :169 only attaches
   cf-turnstile-response when given one) → 403 "challenge verification failed"
   (route.ts:89-103 demands the challenge before bootstrapUser's own already-exists
   read at :136). Normally self-heals in ~150ms — cosmetic console/Sentry noise on
   every signup. LATENT MEDIUM: the listener was designed as recovery after a failed
   first bootstrap (5d105cc2), but that recovery 403s forever for password accounts —
   a siteverify blip during signup leaves a Firebase Auth account with no users/{uid}
   doc and no self-service way out. Recommended fix: hoist the existence read so the
   challenge gates only actual creation (existing doc + no token → 200 alreadyExists);
   test impact mapped in the 2026-08-26 investigation (users-bootstrap.test.ts:131/:161
   need the doc-absent premise made explicit + one new recovery-case test with a
   negative control). Separable from the video work; not applied yet.
   **FIXED 0f9ea359 (2026-08-26, user-approved):** challenge moved into
   bootstrapUser via an onWillCreate hook (one read, no TOCTOU); listener guarded
   by a promise ref (a boolean would strand loading:true and re-kill the recovery
   path); both halves negative-control-proven; jest 3896 green. Residuals flagged
   for triage, not fixed: concurrent creates double-write the doc + double
   audit-event (deliberate prior non-transactional design — our only production
   trigger is now removed); field validations now run before the challenge
   (immaterial behind session + IP limits, but a real ordering change).
   **DECIDED (user, 2026-08-25): relabel now, wire later** — the ScheduleEditor chip is
   replaced with "times run on each machine's own clock", the outside-window banner is
   reworded as a prediction (still evaluated in site tz — the best predictor, since
   machines live at the site), and docs/dashboard/timezones.mdx row corrected. Wiring
   real site-time evaluation (timezone field on /api/agent/site + dropping the agent's
   name-only guard) is a PLANNED FEATURE needing its own rollout — it flips schedule
   behavior fleet-wide for any site whose timezone differs from its machines' clocks.

## Execution order (per the playbook's §6 repair loop)

0. Decide: new-episode set + numbering; roost badge; product-bug fixes 1-2 (block
   filming).
1. Voiceover pipeline fixes (HIGH items) + doc pins + out/ backup.
2. Script revisions (26 revoice beats + rewrites + new episodes), re-reviewed against
   code before rendering.
3. Scene fixes above; native harness rewrite (install premise + CDP desktop sibling).
4. Re-render changed beats only (dry-run first); re-run all web scenes; native shoots.
5. Assemble in Resolve, episode by episode.
