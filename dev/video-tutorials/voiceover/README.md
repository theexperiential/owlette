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

# re-render a single beat after editing its copy
python generate.py ../scripts/02-install-and-pair.md --only-beat b07
```

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

## Model & audio tags

- Default model is `eleven_multilingual_v2` (stable, broadly available). The intro
  episodes read better on `eleven_v3` — set `model: eleven_v3` in a script's front
  matter, or pass `--model eleven_v3`.
- Scripts can contain ElevenLabs audio tags (`[warm]`, `[pause]`, …). They're passed
  through on `eleven_v3` and **stripped** on every other model, so one script works on
  both. Confirm v3 access on your ElevenLabs plan before relying on it.

## Cost

Billed per character. v2/v3 ≈ 1 credit/char; flash ≈ 0.5/char. The whole series is on
the order of ~25–35k characters of narration — run `--dry-run --all` for the exact
count before committing credits.
