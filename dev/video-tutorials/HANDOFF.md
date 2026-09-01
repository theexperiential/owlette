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
