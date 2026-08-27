# resolve timeline builder

One script, run from inside DaVinci Resolve, that turns an episode's assembly
manifest into a built timeline. The editor's first act becomes a zoom or a
callout — not twenty minutes of dragging clips into rough sync.

Works on **DaVinci Resolve (free edition)**. Verified against the scripting
README that ships with **Resolve 19.0.1** ("Last Updated: 16 July 2024"), at
`%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\README.txt`.

> **Verified in-app 2026-08-27.** A full run built all 17 episode timelines and
> placed 100% of the beats that had footage — zero refused appends, zero clips
> off their requested `recordFrame`. The conform arithmetic and the marker/clip
> frame split below are confirmed against the real API, not a mock.

---

## What it builds

For the episode you pick, in a project called **owlette tutorials**:

| | |
|---|---|
| **bin** | one per episode (`05-keep-a-process-alive`), holding its footage and beat MP3s |
| **timeline** | `05-keep-a-process-alive v1` — 1920x1080 @ 60fps |
| **V1** | **conformed to the narration**: each beat's picture, cut from its footage at the sidecar timecode, trimmed to the beat's MP3 length, placed at the beat's own frame |
| **A1** | every beat's narration MP3, at that beat's cumulative start |
| **markers** | one per beat: `b03 choosing a site`, note carrying the **SCREEN:** direction (plus B-ROLL / ON-SCREEN / NOTE), `customData` = the beat id |

Marker colours: **blue** a beat with an explicit `**SCREEN:**` line, **cyan** a
beat directed only by `**B-ROLL:**` / `**ON-SCREEN:**`, **yellow** a beat with no
voiceover, **red** a beat whose MP3 is missing.

### V1 conform — how picture meets audio

The record harness writes a `<footage>.beats.json` sidecar next to every take:
for each beat, where it starts inside the file and how long its narration runs.
The harness also *enforces* at record time that every beat's picture covers its
narration (+0.75s of handle), so the trim below is always safe.

`build_conform_index` maps beat id → (source file, in-point) across ALL of the
episode's footage: scene takes claim their beats first, inserts and alternate
cuts fill only the remaining ones (ep-03's pairing clip covers its beat while
the unrecorded installer-wizard beats stay empty). Then, per manifest beat:

- source in = sidecar `startSec`, source out = in + the beat's MP3 length,
  record frame = the beat's cumulative narration start. Picture and narration
  land together to the frame.
- a beat with no picture anywhere is left as a **gap on V1** and listed in the
  report — that's a B-ROLL slot for the editor (ep-01 b01/b02) or footage that
  doesn't exist yet (ep-03's wizard, pending the VM).
- there is deliberately **no whole-clip fallback** for a failed conform cut: a
  full-length append would bury the neighbouring beats' segments; a gap plus a
  warning is strictly better.

Footage with **no sidecar** (anything recorded before beat enforcement) makes
the builder fall back to the old butt-joint placement with a loud warning —
that output is NOT synced and the footage should be re-recorded.

Before building, gate the footage with
`python dev/video-tutorials/assembly/vet-recordings.py` — it runs the same edge
audit as the harness plus sidecar coverage, and lists every beat that has no
picture, per episode.

---

## Install

Copy `build_episode.py` into Resolve's per-user Scripts folder, under `Utility`:

```
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\
```

```powershell
copy dev\video-tutorials\assembly\resolve\build_episode.py `
  "$env:APPDATA\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\"
```

- `Utility` makes the script appear on **every** page. `Edit` would scope it to
  the Edit page only; either works, `Utility` is one less thing to remember.
- All-users equivalent, if you'd rather install it machine-wide:
  `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Fusion\Scripts\Utility\`.
- Blackmagic's own README writes the per-user path as `%APPDATA%\Roaming\…`.
  That is a typo — `%APPDATA%` **is** the Roaming folder. Use the path above.
- Resolve enumerates the Scripts folders **on startup**. Restart Resolve after
  copying the file in, or the menu item won't be there.

Resolve must be able to see the manifests. It looks in this order:

1. `$OWLETTE_MANIFESTS`
2. the `MANIFEST_DIR` constant at the top of the script
3. `../manifests` relative to the script (only true in the repo, not once copied)
4. `REPO_DEFAULT` — `C:\Users\admin\Documents\Git\Owlette`

If your clone lives elsewhere, edit `REPO_DEFAULT` (or `MANIFEST_DIR`) once.

---

## Run

1. Generate the manifests, if you haven't:
   ```bash
   cd dev/video-tutorials/assembly
   python gen-assembly.py
   ```
2. Open Resolve.
3. **Workspace → Scripts → build_episode**.
4. Pick the episode in the dropdown and hit **build**.

A summary appears when it finishes: what it imported, what it placed, how many
markers it made, and anything it could not find. The same text goes to
**Workspace → Console** (Py3 tab).

**If the dropdown doesn't appear** — the picker is guarded, so a UI failure
degrades to a clear message instead of a half-built timeline. Set the episode
explicitly at the top of the script and run again:

```python
BUILD_EPISODE = "05"            # or "05-keep-a-process-alive"
```

`$OWLETTE_BUILD_EPISODE` does the same thing without editing the file.

---

## Design decisions

### Audio placement: explicit `recordFrame`, verified by read-back

The obvious worry with `AppendToTimeline` is in the name — append, not place.
It turns out the clipInfo form takes an explicit position. From the shipped
README:

> `AppendToTimeline([{clipInfo}, ...])` — Appends list of clipInfos specified as
> dict of `"mediaPoolItem"`, `"startFrame"` (int), `"endFrame"` (int), (optional)
> `"mediaType"` (int; 1 - Video only, 2 - Audio only), `"trackIndex"` (int) and
> `"recordFrame"` (int).

So each beat's MP3 is appended with `mediaType: 2`, `trackIndex: 1` and
`recordFrame` set to its cumulative start. After each append the script reads
the placed item's `GetStart()` back and reports any clip that landed more than a
frame from where it was asked to go.

**The fallback is the same answer.** The beats are consecutive by design — the
assembly sheet's timecodes are a running sum with no gaps — so if a build of
Resolve ever ignored `recordFrame` and appended sequentially instead, every clip
would land in the same place anyway, give or take rounding. That is why this is
worth doing directly rather than hedging: the failure mode is benign, and the
read-back tells you if it happened.

Rounding, precisely: per-beat frame counts are rounded independently, so the
sum-of-rounded and rounded-sum differ by up to **2 frames** (33 ms at 60fps) over
a full episode — worst case today is ep 02 and ep 17. Markers are placed from the
manifest's cumulative timecode, which is the authoritative one.

### Frames: markers are offsets, clips are absolute

A Resolve timeline starts at `01:00:00:00`, so `GetStartFrame()` returns 216000
at 60fps, not 0. The two APIs disagree about what a frame number means:

- `AppendToTimeline`'s `recordFrame` is an **absolute** timeline frame →
  `GetStartFrame() + beat.start_frame`
- `Timeline.AddMarker(frameId, …)` takes an **offset** from the timeline start →
  `beat.start_frame` (the README's `GetMarkers()` example describes "a single
  green marker at timeline offset 96")

Confusing the two puts every clip an hour away from every marker. The script
derives both from one `start` variable for exactly that reason.

### Timeline format: 1920x1080 @ 60fps, always

Every capture harness records 60fps. Web scenes are 1920x1080; the desktop takes
(eps 3, 9, and the ep-16 report-issue segment) are 1600x900. Rather than a
per-episode format, everything is cut in **1080p** and the 1600x900 takes are
scaled up 1.2x inside it — they're crisp UI captures of a WebView, and 1.2x is
survivable. A per-episode 1600x900 timeline would only push the problem to
delivery.

Frame rate and resolution are set as **project** settings *before* the timeline
is created, because a timeline takes its format at creation and does not
retro-fit. `SetSetting` returns a bool; the script checks it, re-reads the value,
and only complains if it actually differs.

### Rebuilding after footage was re-recorded

A media pool item keeps the frame count and duration read from the file it was
first imported from. Re-recorded takes keep their filenames, so a plain re-run
reuses stale clip properties and can refuse a conform cut that runs past the OLD
duration.

Set `OWLETTE_BUILD_FRESH=1` (the installed menu copy already does) and the build
first deletes, per episode, the bin named after the stem and every timeline named
`<stem> v<N>` — then rebuilds, re-importing every file. One click, no manual
cleanup, and no need to delete the project.

It only removes what this script generates. A timeline you RENAMED (`03-install-and-pair v2 FINAL`)
does not match the pattern and survives — which is also how you protect an edit
you care about before a fresh run.

### Timelines are versioned, never overwritten

Each run makes `stem v1`, `v2`, `v3` … A re-voice therefore never destroys an
edit in progress: you get a fresh correct timeline beside the old one and can
copy your zooms across.

### The bin is re-used, media is not re-imported

Re-running against an existing episode bin matches clips by `File Path` and
re-uses what's already there, so you don't accumulate five copies of the same
MP3 in the media pool.

---

## After a re-voice

```bash
# 1. re-render the beats that changed
cd dev/video-tutorials/voiceover
python generate.py ../scripts/05-keep-a-process-alive.md --changed

# 2. regenerate sheets + manifests (durations and timecodes shift)
cd ../assembly
python gen-assembly.py

# 3. in Resolve: Workspace -> Scripts -> build_episode -> same episode
```

You get `05-keep-a-process-alive v2` with the new timings. The old timeline is
untouched — copy your zooms and callouts over, then delete it.

Running `gen-assembly.py` from a git worktree needs `--media-root` pointing at
the checkout that holds `voiceover/out/` and `web/e2e/.output/`; both are
gitignored, so a worktree has neither.

---

## First run

Untested in the app. These are the calls to watch, worst first — if the script
misbehaves, it is almost certainly one of these.

1. **`recordFrame` on the audio appends.** The one that decides the whole design.
   The script reports every clip that landed more than a frame off. If they all
   drift, `recordFrame` is being ignored on your build — check whether the clips
   still ended up butt-jointed on A1 (they should) and read
   [audio placement](#audio-placement-explicit-recordframe-verified-by-read-back).
2. **`timelineResolutionWidth` / `timelineResolutionHeight`.** `timelineFrameRate`
   is documented in the README's settings section; the two resolution keys are
   conventional but *not* enumerated there. If the summary warns that either
   returned False, set the timeline format by hand in Project Settings and say
   so — the key names are the suspect.
3. **`AddMarker` colour names.** Blue / Cyan / Yellow / Red are long-standing,
   but the valid list is not in the README. A rejected colour is reported per
   beat; change the four `COLOR_*` constants at the top if so.
4. **The `clipInfo` source range.** The script asks for `startFrame` 0 →
   `endFrame` = `Frames - 1` and retries without them if the append returns
   nothing. If MP3s come in truncated or doubled, that retry is where to look.
5. **The UIManager picker.** `fusion.UIManager` + `bmd.UIDispatcher` is the
   documented Fusion UI route and `resolve.Fusion()` is documented, but the exact
   widget calls are not in the Resolve README. Wholly guarded — worst case you
   get "episode picker unavailable" and set `BUILD_EPISODE` by hand.

Sanity checks once it has run:

- The timeline is 1920x1080 @ 60fps (Timelines → right-click → Timeline Settings).
- Marker `b01` sits on the first frame, and the last beat's marker sits at the
  narration total on the assembly sheet.
- A1 clip 1 starts at the timeline start, and each next one starts where the
  previous ended.
- Marker notes contain the `SCREEN:` text — that is the direction the edit is
  built from.

---

## Files

| | |
|---|---|
| `build_episode.py` | the in-app script — copy this into Resolve's Scripts folder |
| `../gen-assembly.py` | writes the sheets and `../manifests/*.json` |
| `../manifests/NN-slug.json` | per-episode: meta, absolute media paths, per-beat id / title / screen_note / duration / start |

## addendum — deep-research findings (2026-08-26, verified against BMD sources)

- **Do not update Resolve past 19.0.1 if you want the episode-picker dialog.**
  UIManager script GUIs became Studio-only in Resolve 19.1 (BMD product manager,
  Nov 2024 forum post); 19.0.1 — this machine's version — is the last free
  release where the picker works. The `BUILD_EPISODE` constant fallback at the
  top of build_episode.py survives any version, so the script itself stays
  usable after an update; only the dialog dies.
- Workspace → Scripts on the FREE edition is officially fine (BMD developer
  support, Dec 2025: "loaded internally and executed, no differently to
  copy/pasting into the console"). External/remote scripting stays Studio-only.
- Resolve embeds no Python — it binds a system 64-bit install via the registry
  (this box: 3.9.13 most likely). `resolve` / `fusion` / `bmd` are pre-injected
  globals in-app; `import DaVinciResolveScript` is only for external use.
- Never instantiate tkinter inside Resolve (documented crash on 16.x, unverified
  on 19 — the script doesn't use it; keep it that way, or subprocess it).
- Marker colors: exactly 16 valid names (Blue, Cyan, Green, Yellow, Red, Pink,
  Purple, Fuchsia, Rose, Lavender, Sky, Mint, Lemon, Sand, Cocoa, Cream) —
  capitalized strings, positional args only, note BEFORE duration.
- `SetSetting` can return True and still not take — the script already
  reads back and warns; trust the read-back, not the boolean.
- Free-edition output ceiling is UHD — irrelevant at 1080p.
