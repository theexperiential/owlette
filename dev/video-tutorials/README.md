# Owlette video tutorial series — production workspace

Everything needed to produce the layperson-facing video tutorial series: scripts,
the ElevenLabs voiceover pipeline, the Playwright web-capture harness, and the
pywinauto native-capture harness for the installer / agent GUI / tray.

Developer-centric surfaces (REST API, CLI, SDK) are **deliberately excluded** — see
`series-outline.md`.

---

## The pipeline at a glance

We **decouple voice from picture**. The script is the single source of truth; voice
and screen are produced from it independently and assembled last.

```
 scripts/NN-*.md            ┌─────────────────────────────┐
   (dual-track:             │  1. write / edit the script │
    SCREEN + VOICEOVER) ───▶│     (scripts/NN-*.md)       │
                            └──────────────┬──────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              ▼                             ▼                            ▼
   ┌────────────────────┐      ┌────────────────────────┐    ┌────────────────────┐
   │ 2a. VOICEOVER       │      │ 2b. WEB CAPTURE         │    │ 2c. NATIVE CAPTURE  │
   │ voiceover/generate  │      │ web/e2e/videos/*        │    │ capture-native/*    │
   │ → per-beat MP3s     │      │ (Playwright @1080p,     │    │ (pywinauto drives   │
   │ via ElevenLabs      │      │  seeded demo fleet)     │    │  installer/GUI/tray │
   │                     │      │ → per-scene .webm       │    │  + OBS/ffmpeg cap.) │
   └─────────┬───────────┘      └───────────┬─────────────┘    └─────────┬──────────┘
             │                              │                            │
             └──────────────┬───────────────┴────────────┬───────────────┘
                            ▼                             ▼
                  ┌──────────────────────────────────────────────┐
                  │ 3. ASSEMBLE in an editor (DaVinci Resolve,     │
                  │    free): drop per-beat MP3s under the matching│
                  │    screen capture; trim screen to voice length │
                  └──────────────────────────────────────────────┘
```

Why decoupled: when copy changes you regenerate one MP3, not a whole take. The
per-beat MP3 naming (`ep02-b03.mp3`) lines each clip up with the beat that produced
it, so syncing in the editor is drag-and-drop, not guesswork.

---

## Owlette spans three surfaces — only one is browser-automatable

| Surface | What it is | How we capture it |
|---|---|---|
| **Web dashboard** | Next.js app | **Playwright** (`web/e2e/videos/`) drives it at 1080p against the seeded emulator demo fleet. Fully scriptable / repeatable. |
| **Installer** | Inno Setup `.exe` wizard | **pywinauto** (`capture-native/`) — Playwright cannot touch native windows. |
| **Agent GUI + tray** | Tkinter window + notification-area icon | **pywinauto** (or manual over Parsec/OBS — these flows are short and one-time). |

pywinauto is the desktop equivalent of Playwright (drives Win32/WinForms/WPF). It is
the maintained choice in 2026 — WinAppDriver is paused, FlaUI is .NET-only.

---

## Directory map

```
dev/video-tutorials/
├── README.md            ← you are here (production bible)
├── series-outline.md    ← the 13 episodes: goals, prereqs, durations, capture surface
├── SCRIPT-FORMAT.md     ← the dual-track script format + the generate.py parser contract
├── scripts/             ← one markdown script per episode (NN-slug.md) — all 13 written
├── voiceover/           ← ElevenLabs voiceover generation
│   ├── generate.py      ← parse script beats → per-beat MP3 via ElevenLabs REST
│   ├── requirements.txt
│   ├── .env.example
│   └── README.md
└── capture-native/      ← pywinauto-driven capture of installer / GUI / tray
    ├── recorder.py      ← screen-capture helper + pywinauto driving utilities
    ├── requirements.txt
    ├── README.md
    └── scenes/
        └── install_and_pair.py

web/                     ← the web-capture harness lives in the web project (needs its build + emulator)
├── playwright.videos.config.ts
└── e2e/videos/
    ├── README.md
    ├── video-helpers.ts ← pacing: narrate(), fake cursor, typewriter typing, highlight
    ├── ffmpeg-recorder.ts ← ddagrab/NVENC capture lifecycle (probe gate, ffprobe validation)
    └── NN-slug.video.ts ← one scene per browser episode (01, 03–07, 09–13)
```

---

## Recording tools (the human side)

- **Parsec** — remote into the fresh demo machine to perform the native flows.
- **OBS Studio** — screen-record the native flows (and, if you want best-quality web
  footage, capture a headed Playwright run instead of the built-in `.webm`).
- **DaVinci Resolve** (free) — assemble voice + picture, add zooms / callouts.

You do **not** need a teleprompter in this pipeline — ElevenLabs narrates, so you only
ever perform on-screen actions, never read on camera.

---

## Per-episode workflow

1. **Write / revise** `scripts/NN-slug.md` (see `SCRIPT-FORMAT.md`).
2. **Generate voiceover:** `cd dev/video-tutorials/voiceover && python generate.py ../scripts/NN-slug.md`
   → `voiceover/out/NN-slug/*.mp3` + `manifest.json`.
3. **Capture screen:**
   - Web beats → `cd web && npm run videos -- --grep "<word from the test title>"` (e.g. `--grep "dashboard"`) → `.mp4` per scene. Scenes exist for all browser episodes (01, 03–07, 09–13); episodes 02 + 08 are native-capture — their implementation plan is `dev/active/native-capture-pipeline/PLAN.md`.
   - Native beats → start OBS, run `python capture-native/scenes/<scene>.py`, stop OBS.
4. **Assemble** in Resolve: lay the screen capture on the timeline, drop each
   `ep NN-bNN.mp3` under its beat, trim the screen clip to the voice clip's length,
   add zoom/callouts per the `**SCREEN:**` notes.
5. **Review** against the beat's intent; re-generate any beat whose copy changed.

---

## Conventions that keep captures clean

The screenshots harness already proved these out; the video harness inherits them:

- **Fixed clock** (`FIXED_NOW_MS`, 2026-04-15) so "5m ago" labels never drift.
- **Disabled CSS animations** before capture so motion is intentional, not jittery.
- **Seeded PRNG** for metric sparklines so the demo fleet looks identical every run.
- **Deterministic ids** (`media-server-stage`, `td-control-room`, …) so machine names
  read like a real AV/signage operation, not `test-machine-1`.

The seeded demo fleet (10 machines: lobby displays, museum kiosks, media servers,
render nodes, touring rigs) lives in `web/e2e/screenshots/fixtures.ts` and is reused
verbatim by the video harness.
