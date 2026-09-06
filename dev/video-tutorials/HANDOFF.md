# Video tutorials — handoff

**Written:** 2026-08-31, at the end of a long session with rosco.
**For:** Fable, taking over the remaining video work.
**Repo state at handoff:** branch `dev`, HEAD `700e0e78`, 4 commits unpushed, 9 files uncommitted.

Read this whole file before touching anything. Several of the traps below cost
hours to find, and at least three of them destroy work silently.

---

## 0. Update — 2026-08-31, Fable session (later the same day)

Status of the items below, after working the suggested order:

- **§3.1 DONE, 0 credits.** ep03 re-split cleanly. ep04's "missing" marker was a
  NOISE-FLOOR problem, not a gap-length one: the fifth marker sat at
  102.9–103.5s with room tone between −40 and −35 dB. `render-continuous.py`
  grew a `--noise` flag; `--split-only --noise -35` split ep04 at 0% drift.
  Provenance test: clean across 17.
- **§3.2 DONE, and bigger than the table said.** `normalize-levels.py` now
  measures the CURRENT beats (concatenated) against the series MEDIAN — it is
  idempotent by construction, needs no state file, and a re-split episode heals
  on the next run. Running it exposed two unknown defects: ep01 had NEVER been
  level-matched (its current beats are a different, −2.6 dB-quieter render than
  the backup; it has no `_continuous.mp3`), and ep07 had been DOUBLE-GAINED by
  the old script's non-idempotence. Both corrected. Final spread 0.32 dB —
  which is the floor: a 192k re-encode generation measurably loses ~0.26 dB, so
  corrections below `SKIP_DB = 0.35` are deliberately not attempted.
- **§5.1 DONE.** Every cut is verified by ffprobe READ-BACK after writing; a
  failed or ineffective write aborts the episode loudly, naming the beats
  already rewritten.
- **§3.3 DONE** (~2,800 credits, the approved spend). Script rewritten, ep02
  re-rendered + normalized, web spec reshot in order (b01 = the sign-up page
  held; the out-of-order bounce block is deleted), scene re-recorded, vet gate
  clean, b01 frame-checked on camera.
- **§3.6 + §5.2 DONE.** ep01 b02's split lives in its sidecar as a `cuts` list
  (frames, grid-aligned) and `build_episode.py` reproduces it. A fresh-build
  guard diffs every doomed timeline against the layout the generator would
  produce and REFUSES to delete on any difference (`OWLETTE_BUILD_FORCE=1`
  overrides). Verified offline against timings-export.json: ep01 matches WITH
  its cuts; the audio-changed episodes (02/03/04/05/09) correctly refuse — their
  stale v1 timelines will be versioned-up beside, delete them by hand or force
  once. Cuts may also carry a per-cut `file` override so one beat can mix
  footage (built for ep09 b04). Installed Resolve copies synced.
- **§5.4 is WRONG — do not "fix" export_timings.py.** GetEnd() is EXCLUSIVE on
  this build: ep01's five consecutive V1 clips export durations that chain
  EXACTLY onto each next record frame, which an inclusive GetEnd() cannot
  produce. `e - s` is correct; a comment in the file now says so.
- **§3.4 DONE — the drag demo is SHOT and WIRED (2026-08-31 afternoon).**
  ep05 has its new b03 (script + 19.07s VO rendered + normalized; old b03–b07
  renumbered b04–b08 in script AND spec); its web scene re-recorded (7 beats
  clean). The take: `footage/native/05-b03-drag-drop.mp4`, 50s @ 30fps honest,
  marks: drag 5.51s, drop+card 12.78s, confirmed 19.44s, row+toast 21.48s. The
  same take (copied as `09-b04-drag-drop.mp4`) fills ep09 b04's drag half via
  a two-cut `cuts` list on the scene sidecar (seg2 uses `srcLenFrames` — a
  30fps file on the 60fps grid needs the source length said explicitly).
  HOW THE SHOOT WORKS NOW (all learned the hard way, in
  `scripts/vm/22-shoot-drag-drop.ps1`):
  * elevation comes from rosco's one-paste queue runner
    (`%LOCALAPPDATA%\owlette-vm\claude-elevated-queue`);
  * the console must be made FOREGROUND via the Alt-keystroke grant — topmost
    is not enough, clicks are eaten as activation otherwise;
  * a held-button drag REQUIRES injected absolute input
    (`mouse_event MOVE|ABSOLUTE`); SetCursorPos moves silently kill the drag
    (fine for hovers — tooltips lied about this working);
  * the tray is NOT reliably clickable this way — the window opens via a
    SECOND INSTANCE (no `--tray`) launched by an interactive scheduled task,
    verified by `tmp/gui.pid`;
  * the script refuses to drive input unless the host has 30s of input quiet
    (a take once fought rosco's live mouse — his cursor was on the LEFT
    monitor at negative X, which also crashed a uint conversion);
  * push (21) stops the SERVICE before the copy — it used to lose the race and
    relaunch the app onto a locked exe. The relaunch on the 3.2.1-service
    guest raised an unattended cmd UAC once (the 3.2.3 fix is app-side only);
    Esc via Msvm_Keyboard answers it on the secure desktop.
  LEFTOVER: the take really added "lobby-wall" (launch mode off) to
  OWLETTE-E2E-01's config — the machine is paired to PROD ("TEC Prod",
  site-1). Remove it in the app or let the next VM revert wipe it. The window
  footer reads v3.2.1 (the agent's version; the UI itself is the pushed 3.2.3)
  — cosmetic, rosco may care for §3.7/§3.8 re-shoots.
- **§3.8 partial:** the ep03 web spec's seeded `LATEST_VERSION` is now 3.2.3
  (prod ships 3.2.3 since 2026-08-31). The native re-shoots still pend — NOTE
  their staging path REVERTS the VM, which destroys the pairing and the pushed
  desktop build, so shoot the drag demo FIRST.
- **simulate-conform: 0 problems, 17/17**, with ep05 b03 as the one expected
  gap. `vet-recordings.py` clean on the two new recordings.
- **Evening review round (rosco auditing in Resolve), all addressed:**
  * The first fresh build played broken audio on the five re-voiced episodes —
    the guard kept their BINS, and re-used media pool items replay stale
    durations/decoded audio when files change on disk. Repair = force-rebuild
    from clean bins ("owlette rebuild revoiced" menu script, currently
    targeting 02,04); the builder now warns loudly when building against a
    kept bin. `OWLETTE_BUILD_EPISODE` accepts a comma list.
  * ep02 b01 copy re-written per rosco (care-led opening: "before owlette can
    look after your machines..."), re-rendered + re-recorded.
  * ep04 re-cut per rosco: b03 reveals metrics/displays/processes AS NAMED
    (section state is SHARED across cards - UI behavior, not a bug), b04 shows
    list view rolled up on the line then one row expanded, b06 hover moves at
    the spoken cadence. ALL in-beat actions are cued to measured phrase
    timings - `voiceover/measure-phrases.py` (silences + char-proportional
    offsets); NEVER eyeball dwells again, and re-measure after any re-render.
  * `slowScrollToBottom` is now CONSTANT SPEED (was easeInOutCubic - reads as
    crawl/whoosh/crawl on long pans) and ep04's snap-back-to-top moved into
    the beat's trimmed tail. Affects every future re-record, deliberately.
  * ep04's old take head carried ~1.4s of v3 garble (junk noise before the
    first word) - replaced by the re-render; `render-continuous.py --head-trim`
    exists for the next time a take opens with junk. ep02's new take needed
    `--noise -35` to split, same as ep04 before it.
  * Selector traps burned takes: a shadcn Select trigger also carries
    `lucide-chevron-down` (filter collapsed-section triggers with
    `button.w-full`), and a beat's dwells must COVER its narration before any
    "tail" action or the action lands on camera.
- **Night wave — the "boring" verdict, all shipped:**
  * 0.6s inter-beat breath series-wide (gen-assembly BREATH_S, clamped per
    beat to the footage; both hand-cut beats extended to their new slots).
  * `dashboard-mixed-states` fleet made REAL: per-machine monitor specs
    (portrait kiosks, 4K signage, triple operator walls — seed.ts `monitors`
    option) and 12 processes across 8 machines. lobby-display stays bare (docs
    stills) — do not "fix".
  * MOTION across the board: `slowPush` in video-helpers (capture-side camera
    pushes; Resolve cannot script animated transforms). RULE: a move starts by
    ~60% of the beat and resolves >=1s before it ends, and clicks/highlights
    are charged against the beat budget — ep04 b01 taught both. `slowScroll`
    is constant-speed now. ep04 hand-cued to measured phrases; the other
    scenes' four biggest holds each split by transformer. ep03 untouched (no
    long holds). 15 scenes re-recorded in one batch, 15/15 pass, conform 0.
  * ep12 re-shot twice: an Acrobat window (an ELECTROSONIC brochure) sat over
    b06-b08 in the old take — vet's edge gate cannot see mid-frame windows;
    frame-sweep new native/web takes by eye. Backlog: a mid-frame
    contamination gate for vet-recordings.
  * 01-b02's re-record wiped rosco's hand-cut sidecar entry (harness rewrites
    sidecars) — cuts RE-AUTHORED against the new take (seg2 srcIn 768→741,
    frame-verified); rosco must review that beat. LESSON: hand `cuts` entries
    die with a re-record — re-author from the cutsNote intent.
  * A batch spec transformer corrupted 10 files once (import insertion shifted
    splice offsets): compile()-check and assert-count after ANY scripted
    multi-file edit; git checkout recovered 8, session edits were re-applied
    to 02/05 by anchor.
- **Overnight close (2026-09-01 ~00:45), all green:** modal-jump scenes +
  contaminated + collision-corrupted takes re-recorded (10/10, idle-guarded);
  ep06 re-rendered (rosco-approved ~1,900 credits; healthy 121s take), split,
  leveled (in-place-write fallback beat a media player's persistent locks),
  and its scene recorded. ep01-b02's hand cut re-authored a second time (each
  re-record wipes it - it now rides srcIn 16/702 on the third file of the
  day). FINAL STATE: 17/17 episodes conform 0 problems / no gaps, vet 0
  failures, provenance clean, levels converged, ep05-b04 dialog + motion
  frames eyeballed good.
- **Morning wave 2026-09-01, closing the board:** ep07 + ep16 were the last
  mixed-provenance episodes (deep test: temp-split every take, diff live beat
  durations - `scratchpad provenance_deep`; worth promoting into the repo) -
  both re-split free + re-recorded. ep11 b04 is now a REAL demo: synthesized
  drop (DragEvent with File objects + EMPTY items to force the loose-files
  fallback), real targets, real upload through the NEW e2e chunk seam
  (`/api/chunks/e2e-put` - presignPutChunk was the one unstubbed function;
  browser PUTs died on R2 CORS), PreUploadSummary confirm shown as a beat,
  agents played with the REAL published versionId (a placeholder renders
  "awaiting agent"), b06 rollback switched back to stage-show (history).
  Product fix committed: distribute-dialog checkbox double-toggle
  (stopPropagation + regression tests). ep04 b02's "let's open one up" promise
  trimmed (b03 owns the reveal), episode re-rendered/-cued/-recorded. FINAL:
  conform 0/17-17, vet 0, provenance shallow+deep clean, levels converged.
- **Still rosco's:** ep01 b02 REVIEWED AND APPROVED 2026-09-01 ("sounds
  great") — the re-authored cut mechanism is validated. Remaining: the motion
  feel overall + ep11/ep13 (kept from batch-1; glance for modal jumps),
  Resolve backups preference, VM leftovers (lobby-wall process on
  OWLETTE-E2E-01/prod; §3.7+§3.8 native re-shoots via the runner — they
  REVERT the guest, coordinate first).
- **2026-09-01 smoothing + cards + superadmin wave:**
  * TITLE CARDS built (`web/e2e/videos/title-cards.video.ts` + own config —
    no app server): main card (4.2s, eye + wordmark + "episode NN" + title)
    and section cards (2.6s, per titled beat), rAF fade+slow-scale.
    THE STEPPING LESSON, twice-learned: an animated scale on a normal layer
    re-rasters and snaps to device pixels — "stairs, not a slide" (rosco).
    Cards fix = author at 2×, base `scale(.4925) translateZ(0)`,
    `will-change: transform, opacity` → GPU downsample per frame. The app's
    dot grid added to the card stage (rosco: brighter — now
    `oklch(0.55 .1 250 / .5)` 1.5px dots + vignette). Preview approved in
    motion ("much smoother!"); brighter-dots render pending his eyeball.
    Batch RENDERED 2026-09-02 (146 cards: 17 main + 129 section, 11.4 min)
    after two more banding rounds: QP 18→12 alone didn't fix the vignette
    ring — the real culprit was ffmpeg's RGB→limited-YUV conversion crushing
    near-black steps, so the recorder now dithers with uniform temporal
    noise on planar RGB BEFORE yuv420p (`noise=alls=6:allf=t+u`, both
    capture paths; CSS grain can't reach near-black — blend modes scale
    with luminance). NOTE: the 17 episode scenes were shot on the OLD
    chain (QP 18, no dither) — busier UI hides it, but a full re-record
    batch is the consistency fix if banding shows in review.
    ASSEMBLY INTEGRATION SHIPPED: cards live ON the beat grid.
    gen-assembly bakes `main_card` (episode head) + per-beat `card`
    (section card butted before every beat except the first) into
    start_frames; build_episode.card_slots() places them on V1 (silent),
    beat_segments subtracts the next beat's card from grid_len, and
    simulate-conform treats a gap equal to the next beat's card as filled.
    A missing card file = no slot, so the pipeline is card-optional.
    Conform: 0 problems, 17/17 with cards. Installed Resolve copies synced.
  * SAME FIX APPLIED TO `slowPush` (video-helpers.ts): `will-change:
    transform` on body for the animation, every frame `scale(s) translateZ(0)`
    (composited), cleared at rest so the page re-rasters sharp. All 16
    push-bearing scenes (every scene except 03) re-recorded on rosco's order.
  * NEW TRAP — IN-PLACE MP3 REWRITES POISON RESOLVE'S DECODE CACHE
    (2026-09-02, caught by the CEO): normalize's locked-file fallback
    (truncate+write, same file identity) let Resolve keep serving its CACHED
    decode of the old audio THROUGH a bin delete + fresh re-import — five
    episodes shipped with narration clipped mid-sentence (02 ×5 beats,
    04-b03, 07-b07, 14-b01/b02, 17-b07/b09; audit = silencedetect death-map
    vs manifest slots). The mp3 bytes on disk were always correct. Fixes:
    the fallback is now a HARD FAIL naming the lock holder, and scratchpad
    `refresh_mp3_identity.py` (run with Resolve CLOSED) gives every beat mp3
    a fresh identity before the rebuild. Also surfaced by the same rebuild
    log: ep03's footage predates its 08-31 re-split (all 10 beats,
    re-recorded 2026-09-02) and ep09's native takes predate the re-voice
    (8 beats — pending the §3.7/§3.8 VM re-shoots).
  * NEW TRAP — RE-VOICE ⇒ GEN-ASSEMBLY ⇒ ONLY THEN RECORD: the recorder's
    narrate()/hold enforcement reads beat durations from the ASSEMBLY
    MANIFESTS (video-helpers `beatDurationsFor`), not the mp3s. Recording
    ep14 right after re-rendering its VO but before `gen-assembly.py`
    enforced the OLD durations — a beat ended short (conform HOLE) and
    another held 13s of dead slack. Order is: render → normalize →
    gen-assembly → record.
  * NEW TRAP — OTHER CLAUDE SESSIONS POISON TAKES: a concurrent Embody
    session's TouchDesigner smoke test took the foreground mid-take and
    replaced ep15 with a TD window. The idle guard can't catch it (window
    launches aren't user input) and the vet edge gate can't reliably flag a
    full-window overlay with dark edges — it only WARNed. Detection was a
    VISUAL frame sample (contact sheet of every take recorded near the event);
    fix was ListAgents → SendMessage asking the Embody sessions to hold
    foreground windows, then re-record. Before any future batch: check
    ListAgents for live sessions that might launch windows, and ask first.
  * SUPERADMIN DE-SCOPED from public-facing narration (his rule: superadmin is
    internal-only; orgs only ever see admin). ep02 b09 + ep17 b06 rewritten to
    "your platform operator's view" framing, re-rendered (~5,700 credits,
    approved), normalized, re-recorded. ep17 b07 audited: already correct
    (site-admin revoke). ep14 RESOLVED as a PRODUCT decision (2026-09-01):
    rosco ruled site admins absolutely need admin-panel access — the
    superadmin-only gate on /admin/* is an app gap, not a script problem.
    Gap report for the implementing agent:
    `dev/active/site-admin-panel-access/REPORT.md`. ep14 stays on hold until
    that ships, then films against the real site-admin UI.
- **2026-09-05 late — site-time wave 3a video slice (task 3.7 + 3b.2 audio):
  SCRIPT/SCENE WORK DONE, BOTH CAPTURES AND THE REVOICE DELIBERATELY NOT RUN.**
  * **3.7 (a)+(b) done.** The ep06 b06 NOTE (`scripts/06:58`) and the scene
    header TIMEZONE block (`videos/06-run-on-a-schedule.video.ts:23-28`) both
    asserted "site-time evaluation is designed but not wired / the agent can
    never read the site document" — INVERTED by wave 2 (shipped inside the
    3.2.3 installer) and wave 3a (`cac83105`). Both rewritten to the real
    three-state contract: `sites/{siteId}.schedulesFollowSiteTime` absent =
    never asked, `false` = declined, `true` = site time; only `true` renders
    the `source="site"` chip or swaps the copy, and absent/`false` keep
    "times run on each machine's own clock" byte for byte
    (`web/lib/scheduleClockCopy.ts`).
  * **The scene now PINS the flag to `false` on its own site doc** (never in
    `seedScreenshotFixtures` — absent must keep meaning machine-local for every
    other scene's frames). Reason, and it is the thing to know before
    re-shooting any schedule episode: `SiteTimeConfirmBanner` renders for a
    site admin whenever the flag is `undefined` AND the site has >=1 scheduled
    process. ep06 b03 SAVES the process as scheduled on camera, so on a
    flag-absent site the banner pops in above the machines heading partway
    through, shifts the layout under b03-b07, and prints an amber "these
    machines run an agent older than 3.2.3" line naming the fixture's seeded
    `agent_version: '3.0.0'` machines. Unnarrated warning card in a tutorial.
  * **WHAT ACTUALLY CHANGES ON CAMERA when ep06 is re-shot** (only reason the
    re-capture is needed at all): the process dialog's schedule-config header.
    It used to print `times in Los Angeles` whenever a site timezone existed —
    asserting site-time evaluation the agent only performs for an opted-in site
    — and now prints the honest machine-clock string. That is a b02 frame, and
    the whole web scene re-records as one take. Everything else in ep06 is
    byte-identical at flag `false`, INCLUDING the outside-window banner string
    the scene exact-matches at `:227-231`.
  * **(d) b06.5 "teach the flag" beat SKIPPED, deliberately.** It is not small:
    a new beat means new VO, and a cold per-beat render breaks the continuous
    take's timbre (see section 4), so the honest version is a whole-episode
    re-render (~1,900 credits, unapproved) plus b07 -> b08 renumbering plus a
    re-record. Left for rosco to price. If he wants it, shoot that version with
    the flag ABSENT so the banner is on camera as the subject.
  * **(c)+(e) CAPTURE NOT RUN - PRECONDITION FAILURE, and this is the finding.**
    The checkout was clean at the start of this session and 15 minutes later
    held three unrelated in-flight workstreams from concurrent sessions:
    `desktop/` (task 3.4 - a `vitest run` fired in `desktop/` seconds before
    the check), `web/components/CreateSiteDialog.tsx` + a new test + a
    `useFirestore.ts` edit (that is task **3b.1**, landing live), and a large
    roost project-distributions removal (deleted API routes, actions and hooks
    with `RoostsPageClient.tsx` modified) plus a modified `firestore.rules`.
    `npx tsc --noEmit` in `web/` is RED because of it (9 errors, all stale
    `.next*/types/validator.ts` references to the deleted distribution routes;
    zero in the video files). `npm run videos` wipes `.next-e2e` and rebuilds
    from whatever the tree holds, so a capture now films a half-landed app -
    and it seizes the primary display fullscreen for ~15 min while the
    `desktop/` session is one step away from `npx tauri build` + launching the
    app, which is exactly the concurrent-window trap that already cost ep15.
    A worktree does not help: the shared resource is the one 1080p display.
  * **3b.2 AUDIO ABORTED at the dry run, correctly - the changed-set is NOT
    {b08}.** `python generate.py ../scripts/02-day-zero.md --changed --dry-run`
    reports **{b01, b09}, 658 chars ~= 658 credits**, and b08 as *unchanged*.
    Two separate causes, one of them a NEW PIPELINE TRAP:
    - **`render-continuous.py` never writes `manifest.json`** (zero occurrences
      of the word in the file). `generate.py --changed` diffs the script against
      that manifest's recorded per-beat `text`, so every beat re-voiced through
      the continuous path still carries its PRE-rewrite text there. ep02's
      manifest still holds the retired b01 opener ("owlette holds the keys...")
      and the retired superadmin b09 - both correct on disk, both stale in the
      manifest. So `--changed` on ANY continuously re-voiced episode targets
      beats that are already right, spends credits, and replaces continuous-take
      audio with cold per-beat renders (timbre break + provenance goes MIXED).
      Treat `--changed` as unsafe series-wide until `render-continuous.py`
      writes the manifest text back; `--only-beat` is the safe targeting mode.
    - b08's VOICEOVER text has not been rewritten yet, and it cannot be written
      from here: its new copy depends on the CreateSiteDialog change (3b.1),
      which is uncommitted and in flight in this same tree. Writing it now would
      voice a dialog behavior that does not ship.
  * **NEW, and independent of 3b.1: ep02 b08 is factually WRONG in shipped
    product as of `cac83105`.** It says the dashboard reads this site's times
    on the site clock "from schedule editors to log windows". On a site that has
    not opted in - which is every existing site - the schedule editor now says
    the opposite in as many words. The log-window half is still true. That is a
    live inaccuracy in a released episode, not a 3b sequencing detail.
  * **Gates run, all green (read-only):** `gen-assembly.py` (17 sheets + 17
    manifests; the ONLY diff is ep06's b06 NOTE string - no beat timing moved),
    `simulate-conform.py` **0 problems, 17/17, ep06 7 placed / gaps=none**,
    `vet-recordings.py 06` **0 failures** (edges CLEAN at 36s/73s/117s, 7 beats
    COVERED, 145.8s) - that is the EXISTING 2026-09-01 take, still intact and
    still the one on disk. `npx eslint` clean on the scene file.
  * **TO FINISH 3.7, once the tree is quiet and one writer owns it:**
    `cd web && npm run videos -- --grep "run apps on a schedule"` (~10 min cold
    rebuild + ~2.5 min take). Aside: `videos/README.md` still warns that test
    titles carry pre-renumbering episode numbers - they no longer do, all 17
    titles match their filenames now, so `--grep "episode 6"` also resolves
    uniquely. Then `python assembly/gen-assembly.py`,
    `python assembly/simulate-conform.py`, `python assembly/vet-recordings.py 06`,
    and eyeball a b02 frame for the new machine-clock string. No Resolve work is
    implied - ep06's b07 native insert does not exist yet and task 3.4 (desktop
    schedule copy) is a separate session's.
- **2026-09-06 — 3.7 CLOSED: ep06 re-captured, gates green, frame verified.**
  Tree was quiet (clean checkout at HEAD `075b6104`), one writer, one display.
  * New take `footage/web/06-run-on-a-schedule.mp4` 146.2s, 7 beats, all cover
    narration, `[edges] clean`. gen-assembly's ONLY ep06 diff is the container
    duration (145.75 -> 146.233) - no beat timing moved, because the VO did not
    change. simulate-conform **0 problems, 17/17**; `vet-recordings.py 06`
    **0 failures**.
  * **FRAME VERDICT: affirmative.** b02 at 37s (beat starts 25.48s) shows the
    process dialog's schedule-config header reading
    `times run on each machine's own clock` - the flag-false string, byte for
    byte, not "times in Los Angeles". Cropped + 2.4x-scaled frame read directly.
    A 49-tile contact sheet over the whole take is clean: no foreign window, no
    console flash, no overlay.
  * **NEW TRAP - `npm run videos -- --grep X` IS BROKEN, and it fails QUIETLY.**
    npm appends extra args to the END of the script string, and `videos` is a
    CHAIN, so `--grep` lands on `firebase emulators:exec`, which exits with
    `error: unknown option '--grep'` AFTER the ~10 min e2e:build has already
    run. Worse, `... | tail -80` hands you tail's exit code, so the run reports
    **exit 0** having filmed nothing. Use the §6.4 form instead - grep INSIDE
    the quoted playwright command:
    `firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e "cd web && npx playwright test --config=playwright.videos.config.ts --grep on.a.schedule"`
    and keep the pattern SPACE-FREE (`on.a.schedule`, `day.zero`): firebase runs
    that inner string through cmd.exe, which does not treat single quotes as
    quoting, so `--grep 'run apps on a schedule'` splits into four argv entries.
    `videos/README.md` documents the broken form - fix it or link §6.4.
    Corollary: e2e:build leaves `.next-e2e` valid, so a second scene shot in the
    same session (no app-code edits between) can skip the rebuild entirely -
    that is how both captures here cost ~3 and ~6 minutes instead of ~13 and ~16.
- **2026-09-06 — 3b.2 CLOSED: ep02 b08 rewritten, revoiced alone, re-shot, re-captured.**
  * **b08 copy.** OLD (373 chars, now false in shipped product): "that dialog
    never asks about the site's clock. it quietly takes the timezone of the
    browser you made it in - wrong the moment your machines live somewhere else.
    fix it now: site switcher, manage sites, then the pencil. the dashboard
    reads this site's times on that clock, from schedule editors to log windows
    - and each machine still keeps its own clock, so set both right."
    NEW (394 chars, +5.6%): "that clock is already set - the create dialog read
    it from your browser and started the site on it. right if you made the site
    where the machines live, wrong the moment they're somewhere else. change it
    here: site switcher, manage sites, then the pencil. new sites follow the site
    clock, so a nine a.m. window is nine at the site on every machine - restarts
    still go by the machine's own clock." The log-window half was DROPPED on
    purpose: which clock renders absolute timestamps is a per-user preference
    (`AccountSettingsDialog` "display times in": machine / user / site), so the
    old sentence only held for one of three settings.
  * **Dry run first, and it planned exactly {b08}**: 394 chars ~= 394 credits,
    8 beats "not targeted - keeps ep02-bNN.mp3". `--changed` still reports the
    wrong set (see the 2026-09-05 entry) - `--only-beat` is the targeting mode.
  * **TRAP - the episode manifest's recorded voice_settings were STALE**
    (stability 0.30 / style 0.00, the pre-August setting) and generate.py
    prefers the manifest over its own defaults, so an unflagged `--only-beat`
    would have rendered the robotic voice next to eight expressive beats. Pass
    `--stability 0.35 --style 0.40` explicitly on any targeted re-render of an
    episode whose manifest predates the re-voice. (This run wrote the right
    values back into `out/02-day-zero/manifest.json`, along with b08's new text.)
  * **TRAP - `generate.py` writes MONO; every continuous-split beat is STEREO.**
    `render-continuous.cut()` forces `pan=stereo|c0=c0|c1=c0`; generate.py has no
    such step, so the fresh b08 came off the API 1-channel - and a mono clip on a
    stereo Resolve track plays in the LEFT CHANNEL ONLY (§4). Converted by hand.
    **And measure the level AFTER that conversion:** duplicating mono into two
    channels raises BS.1770 integrated loudness ~+3 dB, so a gain computed
    against the mono file overshoots by exactly that (it did here: +1.27 dB
    applied, then a -2.75 dB correction). Final: b08 -20.26 LUFS vs its eight
    siblings' -19.99 - 0.27 dB apart, inside SKIP_DB and below the 0.26 dB an
    extra 192k generation costs, so it is done. normalize-levels dry-run: every
    episode "skip", series spread 0.59 dB.
  * **b08 IS NOW THE EPISODE'S ONE MIXED-PROVENANCE BEAT.** 31.24s for 394 chars
    = 12.6 chars/s, against the continuous take's 14.3 - the cold render reads
    ~13% slower, and its timbre is a separate generation. The §3.1 provenance
    test consequently flags `02-day-zero take 211.72 beats 212.82 (+1.10)`; that
    is EXPECTED and is the cost 3b.2 accepted rather than spending ~2,800 credits
    on a whole-episode re-render. rosco should audition b08 against b07/b09 and
    price that. (The same test also shows `17-fleet-maintenance +0.16` - 9 files
    of mp3 frame padding, not a swapped beat; do not go hunting.)
  * **Scene work.** `02-day-zero.video.ts`: b07 now frames the create dialog's
    timezone row (`getByTestId('create-site-timezone').locator('..')`, 3s dwell,
    earlier dwell trimmed 7s -> 4.5s so the create click still lands inside
    b07's 20.2s and is not trimmed off); the b08 STALE-PREMISE note is replaced
    by the real contract, and b08 opens on the manage-sites row's timezone cell,
    located by reading `Intl.DateTimeFormat().resolvedOptions().timeZone` off the
    page - so the beat ASSERTS that the create dialog persisted the zone instead
    of narrating it on faith. b08 re-paced 27s -> 32s for the longer read.
    Header VO table refreshed (it was three re-voices stale).
  * **Gates.** gen-assembly diffs, all justified: ep02 b08 duration 26.1s ->
    31.2s (the re-render), b09's start +5.2s (grid follows), episode narration
    4:06.1 -> 4:11.2, and the two SCREEN direction strings I rewrote (b07 gains
    the timezone row, b08 stops promising a before/after that is never filmed);
    ep06 the container duration only. simulate-conform **0 problems, 17/17**;
    `vet-recordings.py 02` **0 failures** (307.1s, 11 beats COVERED, edges
    CLEAN). `npx eslint` + `npx tsc --noEmit` clean.
  * **FRAME VERDICTS: affirmative, both.** b07 at 148s: "site timezone:
    `America/Los_Angeles` (from your browser)" over "scheduled processes at this
    site run on this clock, on every machine." and the "change timezone"
    disclosure, all legible in the create dialog. b08 at 190s: the manage-sites
    row reads `NYC Office | hue-bay | America/Los_Angeles | 0 machines` - the
    zone the dialog wrote. 64-tile contact sheet over the 307s take is clean.
  * **FOR THE RESOLVE PASS (rosco).** Two episodes changed: **02** (audio AND
    picture) and **06** (picture only). ep02 must be rebuilt FRESH FROM CLEAN
    BINS - a kept bin replays the stale decoded audio (2026-09-02 trap), so run
    scratchpad `refresh_mp3_identity.py` with Resolve CLOSED first, then the
    "owlette rebuild revoiced" path with `OWLETTE_BUILD_EPISODE=02,06`. Every
    ep02 clip after b08 shifts +5.2s on the grid; nothing is hand-cut in either
    episode (ep01 b02's hand cut was not touched). ep06's b07 native insert
    STILL DOES NOT EXIST - the web take is cover footage only, exactly as before.

---

## 1. What this pipeline is

17 episodes. Each episode is a markdown script (`scripts/NN-slug.md`) split into
**beats** (`## [b01] title`, with `**SCREEN:**` direction and `**VOICEOVER:**`
narration). From that:

| stage | tool | output |
|---|---|---|
| narration | `voiceover/render-continuous.py` | `voiceover/out/<slug>/epNN-bXX.mp3` |
| level match | `voiceover/normalize-levels.py` | rewrites those mp3s in place |
| footage | `web/e2e/videos/*.video.ts` (web), `web/e2e/desktop-videos/*.video.ts` (desktop), `scripts/vm/*.ps1` (native) | `footage/<surface>/<scene>.mp4` + `.beats.json` sidecar |
| manifests | `assembly/gen-assembly.py` | `assembly/manifests/NN-slug.json` + `assembly/NN-slug.md` sheets |
| dry-run check | `assembly/simulate-conform.py` | pass/fail, no Resolve needed |
| timeline | `assembly/resolve/build_episode.py` | Resolve timelines, run from inside Resolve |

The **sidecar** (`<scene>.beats.json`) is the contract between footage and
assembly: for each beat it records `startSec` (in-point in that file), `mp3Sec`
(the narration length the footage was paced to) and `videoSec` (how much picture
is available from the in-point). The conform reads it to cut V1.

`simulate-conform.py` is your fastest feedback loop. **Run it after every
change.** It currently reports **0 problems** across 17 episodes.

---

## 2. Current state — what is DONE

- **All 17 episodes conform with 0 problems, no gaps.** 128 spoken beats.
- **Narration is re-voiced** at stability 0.35 / style 0.40 (was style 0.0, which
  read robotic), 192 kbps, stereo, every file with a 250 ms lead-in.
- **Each episode is rendered as ONE continuous take** and split into beats, so
  the voice does not change between subclips. See §4 for why, and §5 for the two
  episodes where this is still broken.
- **Levels matched across episodes** — spread closed from 3.53 dB to zero.
- ep03's native footage (b01, b03, b04) and ep09's native tray footage (b01, b02)
  are shot, verified and wired.
- 3.2.1 was built, released to prod and verified on a clean VM during this
  session (that is a separate thread — see `project_vcruntime_host_dependency`
  memory).

---

## 3. Current state — what is NOT done

Ordered by what I would do first.

### 3.1 ep03 and ep04 have MIXED audio sources (**highest priority — audible**)

rosco heard this directly: "my audio sounds all over the place" on ep03.

Some beats in these two episodes are still the OLD per-beat renders sitting next
to beats cut from the new continuous take. The voice changes mid-episode.

Detect it with this test — a clean split always sums to LESS than its take,
because the marker gaps are discarded:

```
cd dev/video-tutorials/voiceover
python - <<'PY'
import glob, os, subprocess
def dur(p):
    return float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration',
        '-of','default=nw=1:nk=1',p], capture_output=True, text=True).stdout.strip() or 0)
for d in sorted(glob.glob('out/*/')):
    if '_retired' in d: continue
    take = os.path.join(d,'_continuous.mp3'); beats = sorted(glob.glob(os.path.join(d,'ep*-b*.mp3')))
    if not beats or not os.path.isfile(take): continue
    t,s = dur(take), sum(dur(b) for b in beats)
    if s > t: print('MIXED', os.path.basename(d.rstrip(os.sep)), t, s)
PY
```

**Right now it reports:** `03-install-and-pair` (take 180.8s, beats 190.6s) and
`04-dashboard-tour` (take 126.9s, beats 132.3s).

- **ep03**: re-split from its kept take — free, no API call:
  `python render-continuous.py ../scripts/03-install-and-pair.md --split-only`
  The last attempt only partly succeeded **because Resolve had the files open**.
  Close Resolve first. Then re-apply its gain (see §3.2).
- **ep04**: its split was **REFUSED** — needs 5 marker gaps, found 4. The take is
  kept at `out/04-dashboard-tour/_continuous.mp3`. Try lowering `MIN_GAP_S` in
  `render-continuous.py` (currently 0.30) after checking the gaps by hand the way
  §6.3 describes. If the markers genuinely are not there, re-render that episode
  (`python render-continuous.py ../scripts/04-dashboard-tour.md`, ~1,900 credits).

### 3.2 Gains were NOT re-applied after re-splitting

A fresh split comes off the raw take, so it is **un-normalized**. The gain script
crashed part-way (Resolve file locks) and ep09 never got its gain.

`normalize-levels.py` is **NOT idempotent** — it measures the untouched
`_continuous.mp3` and would apply the same gain again to already-gained beats.
**Do not just re-run it.** Apply the specific gain per episode:

| episode | gain |
|---|---|
| 03-install-and-pair | −0.81 dB |
| 04-dashboard-tour | −1.61 dB |
| 09-the-owlette-app | −1.27 dB |

```
ffmpeg -v error -i BEAT.mp3 -af volume=-1.27dB -c:a libmp3lame -b:a 192k -y tmp.mp3
```
then replace. **Make it idempotent** (record applied gain in a state file) before
anyone runs it again — that is a real bug waiting to bite.

### 3.3 ep02 rewrite — approved by rosco, not yet applied

rosco: *"the first section talks about keys… and so does the third. it's rather
confusing on screen. shouldn't we be more linear?"*

He is right, and the real fault is **screen order**, not wording:
b01 shows `/setup-2fa`, b02 goes back to `/register`, b03 returns to `/setup-2fa`.

**Approved change** to `scripts/02-day-zero.md` b01:

- SCREEN → `clean browser on the owlette.app sign-up page, held — where a new
  account actually begins.`
- VOICEOVER → drop the "owlette holds **the keys**" metaphor (it collides with
  "a security key" in b03, two beats later). Approved replacement opening:
  `owlette runs every machine you own, so it doesn't hand you a dashboard until
  your account is locked down. two-factor isn't optional here, and there's no
  dismiss button. two minutes, once. let's do the whole first day: account,
  second factor, backup codes, and your first site.`

Nothing is lost by cutting the bounce demo — b02 already says *"either way, you
land on setup — not the dashboard."*

Then: re-render ep02 as one take (~2,800 credits) and re-record its web scene
(b01's screen changed).

### 3.4 ep05 drag-and-drop demo — approved by rosco, not started

rosco: *"you're not going over how a process can be dragged and dropped onto an
agent… I think this is an important feature."* He chose a **full demo** over a
pointer to ep09.

Important context: **the drop has never been filmed anywhere.** ep09 b04 covers
it in narration but films only the `+` button half (10.0s of 28.5s). The header
of `web/e2e/desktop-videos/09-the-owlette-app.video.ts` lists it under shots that
need "live hands or a pywinauto drag from Explorer", because:

> an OS file drop arrives as a Tauri host event (`useFileDrop` listens to
> `onDragDropEvent`, not `ondrop`) that CDP cannot synthesize

**But it is now automatable.** This session proved a real pointer drag on the VM:
`SetCursorPos` + `mouse_event`, DPI-aware, driving the guest through VMConnect.
See `scripts/vm/17-shoot-b03-b04.ps1` for the whole technique. A genuine
press-move-release from Explorer onto the owlette window is exactly that.

Plan agreed with rosco:
1. Push the current desktop build into the VM — `scripts/vm/21-push-desktop-build.ps1`
   is **written and parse-checked but never run**. Use `-SeedDropFile`, which puts
   `lobby-wall.bat` on the guest desktop (a `.bat`, not the `.toe` the script
   specifies, because the VM has no TouchDesigner — a `.toe` would resolve to
   nothing on the confirm card and film a lie).
2. Shoot the drag from Explorer onto the window, capturing the drop overlay and
   the "add process" confirm card.
3. Use that footage for **both** a new ep05 beat and ep09 b04's unfilmed half.
4. ep05 gains a beat after b02, so **b03–b07 renumber to b04–b08**. That is fine
   only because ep05's web scene must be re-recorded anyway (§3.5) — the sidecar
   regenerates with the new ids. Do not renumber without re-recording.

### 3.5 96 of 128 beats have footage paced to superseded narration

The continuous re-voice changed every duration. Nothing errors (coverage is
satisfied everywhere) but the conform trims each beat's picture to its narration
length, so where the new read is **shorter**, the tail of the filmed action is
dropped. Average drift 1.97s, median 1.49s, worst 6.14s. Worst offenders:

| beat | picture held | narration now |
|---|---|---|
| 05-keep-a-process-alive b06 | 30.62s | 24.48s |
| 15-display-layouts b09 | 28.45s | 22.41s |
| 02-day-zero b04 | 27.09s | 21.34s |
| 17-fleet-maintenance b08 | 28.53s | 23.17s |
| 16-logs-and-troubleshooting b04 | 17.16s | 22.26s |

rosco's decision was to **build and spot-check those first** rather than
re-record on spec. If the trimmed tails do not lose anything visible, leave it.
A full re-record (17 web + 4 desktop scenes) is ~50–55 min unattended, no credits.

### 3.6 ep01 b02 is split in two on the timeline — preserve it

rosco hand-edited ep01: b02's picture is **two cuts**, not one.

```
14.417s  len 10.367s  src_in   53   01-what-is-owlette-b02.mp4
24.767s  len 13.217s  src_in  768   01-what-is-owlette-b02.mp4
```

The generator places one clip for b02 (src_in 53). **A fresh rebuild destroys
this.** Agreed fix: add an optional `cuts` list to a beat's sidecar entry and
have `build_episode.py` place each segment in turn instead of placing once. Then
the split is reproducible and the mechanism is reusable.

Until that exists, **warn rosco before any rebuild of ep01.**

### 3.7 Native footage is frame-short

Three VM captures claim 60 fps but contain fewer frames:

| file | claimed | actual |
|---|---|---|
| `footage/native/03-b01-desktop.mp4` | 60 | 50.7 |
| `footage/native/03-b03-b04-install.mp4` | 60 | 34.6 |
| `footage/native/09-b01-b02-tray.mp4` | 60 | 32.4 |

gdigrab cannot sustain 60 fps grabbing a live VM console. Every web and desktop
capture is honest (58–60). Re-shoot with `-Fps 30`, which the capture can hold.
Not urgent — it plays correctly, it is just 30 fps content wearing a 60 fps label.

### 3.8 Smaller open items

- **ep03 b02** films the download page showing **3.2.0**; prod now serves 3.2.1
  and the repo is at 3.2.3. ep03 b01/b03 show `Owlette-Installer-v3.2.0.exe` and
  a hover tooltip reading `File version: 0.0.0.0`, which an unpushed commit
  already fixes. Re-shooting ep03's native beats is one command.
- **The installer is unsigned** — ep03 b03 films a UAC prompt reading
  "Publisher: Unknown". Accurate today; re-shoot if it is ever signed.
- **Resolve project backups are OFF.** Turn on Preferences → User → Project Save
  and Load → Project backups. There was no fallback when we thought rosco's edits
  were lost.

---

## 4. Why the audio pipeline looks the way it does

Do not "simplify" this without reading the reasoning.

**Each episode is one API request, split afterwards.** Rendering per beat makes
every beat a cold take: the model re-derives timbre and noise floor each call and
the voice audibly switches between subclips. The normal remedy is request
stitching, and **eleven_v3 refuses both forms**:

> "Providing previous_text or next_text is not yet supported with the
> 'eleven_v3' model."
> "Providing previous_request_ids or next_request_ids is not yet supported with
> the 'eleven_v3' model."

rosco wants to keep v3 (it carries the `[warm]` / `[concerned]` audio tags and
the expressiveness). So the whole episode is rendered at once and cut apart.

**Beats are joined with `[pause] [pause] [pause]`.** Measured against
alternatives: `<break time="2.5s"/>` → 0.83s (v3 ignores it), `...` → 1.26s,
three pause tags → 3.72s in short text. In a full episode v3 compresses them to
**0.34–2.0s**, which is why `MIN_GAP_S` is only 0.30.

**Cuts are chosen by POSITION, not duration.** Picking the N−1 longest gaps
refused 3 of 16 episodes. Selecting the gap nearest each text-proportional beat
boundary put all 17 through at 1–3% drift. A cut more than
`POSITION_TOLERANCE` (12%) from its expected spot is **refused**, and the take is
kept for inspection — a mis-split desyncs every beat from picture, which is far
worse than an inconsistent voice.

**`normalize-levels.py` uses one gain per EPISODE, never per beat.** Normalising
each beat would undo the consistency the continuous take just bought. The target
is the quietest episode's own loudness so every move is an attenuation — true
peaks already sit near −1 dBTP, so normalising up to a delivery level would need
compression.

**Two things fall out of cutting from one take:** each beat inherits its 250 ms
lead-in from the marker gap it was cut from, and output is stereo. Both matter —
ElevenLabs returns mono with speech starting on sample zero, and a mono clip on a
stereo Resolve track plays **only in the left channel**.

---

## 5. Traps that cost hours this session

1. **Resolve file locks destroy work silently.** Resolve holds handles on every
   imported mp3. Writes fail with `WinError 5`, and worse, `render-continuous.py`
   reported per-episode *success* while leaving stale beats in place — that is
   how ep03/ep04/ep09 ended up with mixed audio. **Close Resolve before any audio
   operation**, and fix the splitter to fail loudly when a cut cannot be written.
2. **`OWLETTE_BUILD_FRESH=1` is baked into the installed Resolve script.** One
   click deletes every timeline before rebuilding. I told rosco to run it without
   knowing he had hand edits. Add a guard that refuses when a timeline differs
   from what the generator would produce.
3. **`timelinePlaybackFrameRate` is separate from `timelineFrameRate`.** The
   project sat at a 60 fps timeline with **24 fps playback**, which presents as
   dropped frames while nothing is dropping. Cost an hour chasing Parsec, codecs
   and monitor refresh. Fixed in `build_episode.py`, which now also **reads the
   values back** instead of echoing what it asked for — the old log line said
   "60fps" while playback was 24.
4. **Resolve's `GetEnd()` is INCLUSIVE.** `export_timings.py` records
   `duration_frames = end - start`, one frame short, which manufactures a
   1-frame gap on every clip pair. Fix it, or account for it when reading.
5. **Resolve replaces `sys.stdout`** with an `fu_stdout` that has no `flush()` —
   an unguarded flush kills a script on its first line.
6. **The free edition only runs scripts from Workspace → Scripts.** Nothing can
   be driven headlessly. The installed copies live in
   `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\`
   and are the repo file plus a small local header — keep them in sync by hand.
7. **`--split-only` used to fall through to a paid render** when the take was
   missing. Fixed, but the lesson stands: takes are now KEPT so re-splitting is
   always free.
8. **Do not trust a "no differences" result** from a structural test. I concluded
   rosco's edits were destroyed on the strength of three checks that all happened
   to be blind to a clip *split* — the giveaway (`A1=5, V1=6`) was in the first
   summary I printed and I read past it. Ask what you might not be measuring.

---

## 6. Recipes

### 6.1 Re-render one episode as a continuous take
```
cd dev/video-tutorials/voiceover
python render-continuous.py ../scripts/NN-slug.md          # renders + splits
python render-continuous.py ../scripts/NN-slug.md --split-only   # re-split only, free
```
Close Resolve first. Costs ~1 credit per character (an episode is 1,500–3,100).

### 6.2 Re-render one beat only (breaks continuity — use sparingly)
```
python generate.py ../scripts/NN-slug.md --only-beat b05
```
Stitching is gated off for v3 automatically. This beat will not match its
neighbours' timbre; prefer re-rendering the whole episode.

### 6.3 Inspect an episode's split before trusting it
```
ffmpeg -hide_banner -i out/<slug>/_continuous.mp3 \
  -af silencedetect=noise=-40dB:d=0.30 -f null - 2>&1 | grep silence_
```
Compare gap positions against text-proportional expectations (see §4).

### 6.4 Re-record footage
```
cd web && npm run e2e:build                     # ~10 min cold, wipes .next-e2e
cd .. && firebase emulators:exec --only auth,firestore,storage \
  --project demo-playwright-e2e \
  "cd web && npx playwright test --config=playwright.videos.config.ts e2e/videos/NN-slug.video.ts"
cd web && npm run videos:desktop                # desktop scenes
```
Use Bash, not PowerShell — PowerShell splats the emulator `--only` list into
three argv entries and the emulators never start.

### 6.5 Regenerate and verify
```
cd dev/video-tutorials/assembly
python gen-assembly.py && python simulate-conform.py
```

### 6.5b Export deliverables from Resolve
**Workspace → Scripts → owlette render all** (repo: `assembly/resolve/render_all.py`,
installed by scratchpad `sync_installed`-style copy). Renders each episode's
NEWEST `{stem} vN` timeline as H.264 MP4 (1080p60, 30 Mb/s — keeps the
de-banding dither) into `OWLETTE_RENDER_DIR` (default: the TEC Dropbox
`x/owlette-video-tutorials` folder), single-clip, video+audio. Skips unbuilt
stems, leaves any existing render queue alone, and writes per-job results to
`assembly/resolve/render-log.txt` for the orchestrator to read. Build first —
render second.

### 6.6 Build in Resolve
Open the `owlette tutorials` project → **Workspace → Scripts → owlette build
episodes**. Reads `OWLETTE_BUILD_EPISODE=ALL`, `OWLETTE_BUILD_FRESH=1`, writes
`assembly/resolve/build-log.txt`. **Fresh deletes existing timelines.**

To capture hand edits first: **Workspace → Scripts → owlette export timings** →
writes `assembly/resolve/timings-export.json`.

---

## 7. Working with rosco

- He reviews output closely and catches real defects — the left-channel audio,
  the inconsistent voice, the ep02 ordering, the missing drag-and-drop feature
  were all his. Take his observations seriously; each one was correct.
- **Verify before claiming.** Several times I asserted something was fixed and it
  was not. He noticed every time.
- Ask before spending credits or re-recording; he tracks the cost.
- Never commit without being asked.
- He is often working on the same machine — **the VM console takes over the
  primary display during a shoot**, and audio operations fight Resolve.

---

## 8. Suggested order

1. Close Resolve. Fix ep03 + ep04 audio (§3.1), re-apply the three gains (§3.2).
   Verify with the provenance test until it reports nothing.
2. Make `normalize-levels.py` idempotent, and make the splitter fail loudly on an
   unwritable cut (§5.1).
3. Apply the ep02 rewrite (§3.3) — approved, just needs doing.
4. Add sidecar `cuts` support so ep01's split survives (§3.6), and the fresh-build
   guard (§5.2).
5. The ep05 drag-and-drop demo (§3.4) — the biggest piece, and it also fills
   ep09 b04's long-standing hole.
6. Decide on the full re-record (§3.5) with rosco, after he has spot-checked.
