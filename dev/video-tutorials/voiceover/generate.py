#!/usr/bin/env python3
"""
generate.py — turn an episode script into per-beat ElevenLabs voiceover MP3s.

Parses the dual-track script format documented in ../SCRIPT-FORMAT.md, extracts
the spoken text from each beat, and renders one MP3 per beat via the ElevenLabs
text-to-speech REST API. Per-beat files (ep02-b03.mp3) line up with the beats that
produced them, so syncing voice to screen in the editor is drag-and-drop.

Usage
-----
    # dry run — parse + print beats + estimate cost, NO api calls (do this first)
    python generate.py ../scripts/02-install-and-pair.md --dry-run

    # render one episode
    python generate.py ../scripts/02-install-and-pair.md

    # render every script in ../scripts/
    python generate.py --all

    # re-render a single beat after editing its copy
    python generate.py ../scripts/02-install-and-pair.md --only-beat b07

Configuration (env or .env in this directory; see .env.example)
    ELEVENLABS_API_KEY    required for real generation
    ELEVENLABS_VOICE_ID   the voice to use (override per-script via front matter `voice:`)
    ELEVENLABS_MODEL_ID   default eleven_multilingual_v2 (front matter `model:` overrides)

Notes
-----
* Default model is eleven_multilingual_v2 — confirmed available through the convert
  endpoint and the docs' pick for stable long-form narration. Switch to eleven_v3 for
  the more expressive intro episodes (front matter `model: eleven_v3` or --model).
* ElevenLabs v3 "audio tags" like [warm] / [pause] are passed through ONLY when the
  model is eleven_v3. For any other model they're stripped before sending, so the same
  script works on both without v2 reading the word "warm" aloud.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# requests is the only hard runtime dep for real generation.
try:
    import requests
except ImportError:  # pragma: no cover - guidance path
    requests = None  # type: ignore[assignment]

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SCRIPTS_DIR = (SCRIPT_DIR / ".." / "scripts").resolve()
DEFAULT_OUT_DIR = SCRIPT_DIR / "out"
DEFAULT_MODEL = "eleven_multilingual_v2"
DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"
API_BASE = "https://api.elevenlabs.io/v1/text-to-speech"

# Lines beginning with these labels are stage direction, never spoken.
DIRECTION_LABELS = ("**SCREEN:**", "**B-ROLL:**", "**ON-SCREEN:**", "**NOTE:**")
VOICEOVER_LABEL = "**VOICEOVER:**"
BEAT_HEADING_RE = re.compile(r"^##\s*\[(b\d+)\]\s*(.*)$", re.MULTILINE)
AUDIO_TAG_RE = re.compile(r"\[[^\]]{1,40}\]")


# --------------------------------------------------------------------------- #
#  .env loading                                                               #
# --------------------------------------------------------------------------- #
def load_env() -> None:
    """Load a .env from this directory into os.environ (without overriding it)."""
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(SCRIPT_DIR / ".env")
        return
    except ImportError:
        pass
    # Minimal fallback so the tool still works without python-dotenv installed.
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


# --------------------------------------------------------------------------- #
#  Parsing                                                                    #
# --------------------------------------------------------------------------- #
class Beat:
    def __init__(self, beat_id: str, title: str, raw_text: str) -> None:
        self.id = beat_id
        self.title = title
        # Cleaned spoken text with audio tags PRESERVED. Whether to strip tags is
        # decided at render time from the resolved model, so the strip decision and
        # the synthesis model can never disagree.
        self.raw_text = raw_text

    def resolved(self, *, strip_tags: bool) -> str:
        """Spoken text for the chosen model — audio tags stripped for non-v3 models."""
        return strip_audio_tags(self.raw_text) if strip_tags else self.raw_text


class Episode:
    def __init__(self, path: Path, meta: Dict[str, object], beats: List[Beat]) -> None:
        self.path = path
        self.meta = meta
        self.beats = beats

    @property
    def number(self) -> int:
        value = self.meta.get("number")
        if isinstance(value, int):
            return value
        # Fall back to a leading number in the filename (e.g. "02-install...").
        m = re.match(r"(\d+)", self.path.stem)
        return int(m.group(1)) if m else 0

    @property
    def slug(self) -> str:
        value = self.meta.get("slug")
        if isinstance(value, str) and value:
            return value
        return re.sub(r"^\d+[-_]?", "", self.path.stem) or self.path.stem

    @property
    def out_name(self) -> str:
        return f"{self.number:02d}-{self.slug}"


def parse_front_matter(text: str) -> Tuple[Dict[str, object], str]:
    """Split a leading `--- ... ---` YAML-ish block into a dict + the remaining body.

    Only scalar `key: value` pairs are supported (all this format needs). `null`
    becomes None and bare integers become ints; everything else stays a string.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")
    meta: Dict[str, object] = {}
    for line in block.splitlines():
        if ":" not in line or line.strip().startswith("#"):
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if value.lower() in ("null", "none", ""):
            meta[key] = None
        elif re.fullmatch(r"-?\d+", value):
            meta[key] = int(value)
        else:
            meta[key] = value
    return meta, body


def clean_voiceover(raw: str) -> str:
    """Drop stray direction lines and collapse whitespace into one spoken paragraph.

    Audio tags are KEPT here; whether to strip them is decided at render time from the
    resolved model (see strip_audio_tags), so the strip decision and the synthesis
    model can never disagree.
    """
    kept_lines = [
        ln for ln in raw.splitlines() if not ln.strip().startswith(DIRECTION_LABELS)
    ]
    return re.sub(r"\s+", " ", " ".join(kept_lines)).strip()


def strip_audio_tags(text: str) -> str:
    """Remove v3 audio tags like [warm]/[pause] and tidy the resulting spacing."""
    text = AUDIO_TAG_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    # Tidy spaces left in front of punctuation after tag removal.
    return re.sub(r"\s+([,.!?;:])", r"\1", text)


def parse_episode(path: Path) -> Episode:
    text = path.read_text(encoding="utf-8")
    meta, body = parse_front_matter(text)

    matches = list(BEAT_HEADING_RE.finditer(body))
    beats: List[Beat] = []
    for i, m in enumerate(matches):
        beat_id, title = m.group(1), m.group(2).strip()
        block_start = m.end()
        block_end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        block = body[block_start:block_end]

        marker = block.find(VOICEOVER_LABEL)
        if marker == -1:
            # A beat with no spoken line (pure b-roll) — keep it visible.
            beats.append(Beat(beat_id, title, ""))
            continue
        spoken_raw = block[marker + len(VOICEOVER_LABEL) :]
        beats.append(Beat(beat_id, title, clean_voiceover(spoken_raw)))

    return Episode(path, meta, beats)


# --------------------------------------------------------------------------- #
#  ElevenLabs                                                                 #
# --------------------------------------------------------------------------- #
def synthesize(
    *,
    text: str,
    voice_id: str,
    model_id: str,
    api_key: str,
    output_format: str,
    stability: float,
    style: float,
) -> bytes:
    if requests is None:
        raise RuntimeError("the `requests` package is required — run `pip install -r requirements.txt`")
    resp = requests.post(
        f"{API_BASE}/{voice_id}",
        params={"output_format": output_format},
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "text": text,
            "model_id": model_id,
            "voice_settings": {
                "stability": stability,
                "similarity_boost": 0.75,
                "style": style,
                "use_speaker_boost": True,
            },
        },
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"ElevenLabs returned {resp.status_code}: {resp.text[:500]}"
        )
    return resp.content


def credits_per_char(model_id: str) -> float:
    return 0.5 if "flash" in model_id.lower() else 1.0


# --------------------------------------------------------------------------- #
#  Driver                                                                     #
# --------------------------------------------------------------------------- #
def resolve_scripts(args: argparse.Namespace) -> List[Path]:
    if args.scripts:
        return [Path(p).resolve() for p in args.scripts]
    if args.all:
        return sorted(DEFAULT_SCRIPTS_DIR.glob("*.md"))
    raise SystemExit("provide one or more script paths, or pass --all")


def resolve_model(meta: Dict[str, object], cli_model: Optional[str]) -> str:
    """Single model precedence, used for BOTH tag-stripping and synthesis so they can
    never disagree: CLI --model > script front matter `model:` > env
    ELEVENLABS_MODEL_ID > default.
    """
    return str(
        cli_model
        or meta.get("model")
        or os.environ.get("ELEVENLABS_MODEL_ID")
        or DEFAULT_MODEL
    )


def render_episode(ep: Episode, args: argparse.Namespace) -> Tuple[int, int]:
    """Print the episode plan and (unless --dry-run) synthesize per-beat MP3s.

    Returns (total_chars, estimated_credits) for the grand-total tally.
    """
    model_id = resolve_model(ep.meta, args.model)
    strip_tags = not model_id.lower().startswith("eleven_v3")
    voice_id = str(args.voice or ep.meta.get("voice") or os.environ.get("ELEVENLABS_VOICE_ID", ""))
    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    out_dir = Path(args.out).resolve() / ep.out_name
    cpc = credits_per_char(model_id)

    # Resolve each beat's spoken text against the chosen model exactly once.
    resolved = {b.id: b.resolved(strip_tags=strip_tags) for b in ep.beats}
    spoken_beats = [b for b in ep.beats if resolved[b.id]]
    total_chars = sum(len(resolved[b.id]) for b in spoken_beats)

    print(f"\n=== episode {ep.number:02d} - {ep.meta.get('title', ep.slug)} ===")
    print(f"  source : {ep.path}")
    print(f"  model  : {model_id}   voice: {voice_id or '(unset)'}")
    print(f"  beats  : {len(ep.beats)} ({len(spoken_beats)} spoken)")
    print(f"  chars  : {total_chars}  ~= {int(total_chars * cpc)} credits")

    for b in ep.beats:
        text = resolved[b.id]
        flag = "" if text else " (b-roll, no vo)"
        print(f"    [{b.id}] {b.title}{flag}")
        if text:
            print(f'          "{text}"')

    if args.dry_run:
        print("  -- dry run: no audio generated --")
        return total_chars, int(total_chars * cpc)

    if not api_key:
        raise SystemExit("ELEVENLABS_API_KEY is not set (env or .env) — cannot generate audio")
    if not voice_id:
        raise SystemExit("no voice id — set ELEVENLABS_VOICE_ID, front matter `voice:`, or --voice")

    out_dir.mkdir(parents=True, exist_ok=True)
    # Build the FULL manifest every run — every beat gets an entry — so --only-beat
    # re-renders a single MP3 without dropping the other beats' metadata.
    manifest: List[Dict[str, object]] = []
    for b in ep.beats:
        text = resolved[b.id]
        if not text:
            manifest.append({"id": b.id, "title": b.title, "chars": 0, "file": None})
            continue
        fname = f"ep{ep.number:02d}-{b.id}.mp3"
        if args.only_beat and b.id != args.only_beat:
            # Not the targeted beat: keep its manifest entry and reference an existing
            # MP3 from a prior run if present; skip (re)synthesis.
            existing = (out_dir / fname).exists()
            manifest.append(
                {
                    "id": b.id,
                    "title": b.title,
                    "chars": len(text),
                    "file": fname if existing else None,
                    "text": text,
                }
            )
            continue
        audio = synthesize(
            text=text,
            voice_id=voice_id,
            model_id=model_id,
            api_key=api_key,
            output_format=args.output_format,
            stability=args.stability,
            style=args.style,
        )
        (out_dir / fname).write_bytes(audio)
        print(f"    ok {fname}  ({len(audio):,} bytes)")
        manifest.append(
            {"id": b.id, "title": b.title, "chars": len(text), "file": fname, "text": text}
        )

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "episode": ep.number,
                "slug": ep.slug,
                "title": ep.meta.get("title"),
                "model": model_id,
                "voice": voice_id,
                "beats": manifest,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"  -> {out_dir}")
    return total_chars, int(total_chars * cpc)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate ElevenLabs voiceover from episode scripts.")
    parser.add_argument("scripts", nargs="*", help="script markdown file(s)")
    parser.add_argument("--all", action="store_true", help=f"process every *.md in {DEFAULT_SCRIPTS_DIR}")
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR), help="output directory (default ./out)")
    parser.add_argument("--voice", default=None, help="ElevenLabs voice id (overrides env + front matter)")
    parser.add_argument("--model", default=None, help="model id (overrides env + front matter)")
    parser.add_argument("--output-format", default=DEFAULT_OUTPUT_FORMAT, help="ElevenLabs output_format")
    parser.add_argument("--stability", type=float, default=0.5, help="voice stability 0-1 (default 0.5)")
    parser.add_argument("--style", type=float, default=0.0, help="style exaggeration 0-1 (default 0.0)")
    parser.add_argument("--only-beat", default=None, help="render just this beat id, e.g. b07")
    parser.add_argument("--dry-run", action="store_true", help="parse + estimate cost, make no API calls")
    args = parser.parse_args()

    # Nicer dry-run preview on UTF-8 terminals (em-dashes etc.); harmless elsewhere.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    load_env()

    paths = resolve_scripts(args)
    grand_chars = 0
    grand_credits = 0
    for path in paths:
        if not path.exists():
            print(f"!! skipping missing file: {path}", file=sys.stderr)
            continue
        ep = parse_episode(path)
        chars, credits = render_episode(ep, args)
        grand_chars += chars
        grand_credits += credits

    print(f"\ntotal: {grand_chars} chars ~= {grand_credits} credits across {len(paths)} script(s)")


if __name__ == "__main__":
    main()
