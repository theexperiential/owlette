# Voiceover generation (ElevenLabs)

Turns the episode scripts in `../scripts/` into per-beat narration MP3s.

## Setup

```bash
cd dev/video-tutorials/voiceover
python -m venv .venv
.venv\Scripts\activate          # Windows  (use: source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
copy .env.example .env          # then fill in ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
```

Pick a voice in the ElevenLabs dashboard and paste its id into `.env`
(`ELEVENLABS_VOICE_ID`). To list voices programmatically:
`GET https://api.elevenlabs.io/v1/voices` with your `xi-api-key`.

## Use

```bash
# ALWAYS dry-run first — parses, previews every beat's spoken text, estimates credits,
# and makes zero API calls:
python generate.py ../scripts/02-install-and-pair.md --dry-run

# render one episode -> out/02-install-and-pair/ep02-b01.mp3, ...  + manifest.json
python generate.py ../scripts/02-install-and-pair.md

# render the whole series
python generate.py --all

# re-render specific beats after editing their copy (repeatable / comma-separated)
python generate.py ../scripts/02-install-and-pair.md --only-beat b04,b06

# re-render only beats whose spoken text differs from the episode's manifest —
# THE way to run a revision pass; preview the list first with --dry-run:
python generate.py --all --changed --dry-run
python generate.py ../scripts/02-install-and-pair.md --changed
```

Beats not being rendered keep their existing MP3s, and the manifest keeps the text
the surviving audio was actually rendered from — so `--changed` stays truthful
across partial passes.

## Output

```
out/02-install-and-pair/
├── ep02-b01.mp3
├── ep02-b03.mp3        (b-roll beats with no VOICEOVER are skipped)
├── ...
└── manifest.json       (beat order, titles, char counts, spoken text)
```

Each `epNN-bNN.mp3` corresponds 1:1 to the `## [bNN]` beat in the script — drop it
under that beat's screen footage in the editor.

## Production settings (locked — do not re-derive)

The entire series shipped on these, A/B-picked 2026-05 (0.3 beat 0.0 and 0.5 for
this voice). A beat re-rendered at other settings will not sit cleanly next to its
neighbors in an episode.

| setting | value | where it lives |
|---|---|---|
| model | `eleven_v3` | pinned in every script's front matter (`model: eleven_v3`) |
| stability | `0.30` | recorded in each episode's `manifest.json`; code default |
| style | `0.0` | same |
| similarity boost / speaker boost | `0.75` / on | constants in `generate.py` |
| output format | `mp3_44100_128` | recorded in the manifest |
| voice | personal PVC (professional voice clone) | **`ELEVENLABS_VOICE_ID` in `.env` only — never commit it; this is a public repo.** PVC voices need ElevenLabs Creator tier+. |

`generate.py` resolves stability/style as CLI > the episode manifest > the defaults
above, so a plain re-render reproduces the shipped sound. The rendered audio in
`out/` is gitignored and exists only locally — **keep an off-machine backup of
`out/`**; together with `.env` it is the only copy of the series' audio.

## Model & audio tags

- Every series script pins `model: eleven_v3` in its front matter (resolution:
  `--model` > front matter > `ELEVENLABS_MODEL_ID` > `eleven_multilingual_v2`).
- Scripts can contain ElevenLabs audio tags (`[warm]`, `[pause]`, …). They're passed
  through on `eleven_v3` and **stripped** on every other model — which is why an
  accidental v2 render both sounds different AND silently drops the performance
  direction. The front-matter pin prevents that. Confirm v3 access on your
  ElevenLabs plan before relying on it.

## Cost

Billed per character. v2/v3 ≈ 1 credit/char; flash ≈ 0.5/char. The whole series is on
the order of ~25–35k characters of narration — run `--dry-run --all` for the exact
count before committing credits.
