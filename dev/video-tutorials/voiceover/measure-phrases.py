#!/usr/bin/env python
"""
measure-phrases.py - where, inside one beat's MP3, does each phrase land?

The recording harness paces on-screen actions with fixed dwells, and every
timing complaint on ep04 (list toggled while cards were still being praised,
the page-switcher hover crawling behind the spoken list) traces to the same
mistake: dwells eyeballed against the text instead of measured against the
audio. This prints the real structure so the spec can cue actions to it:

  1. every internal silence >= --gap seconds (phrase boundaries), and
  2. char-proportional offsets for phrases you name on the command line
     (for cues inside continuous speech, where no gap exists).

Usage:
  python measure-phrases.py out/04-dashboard-tour/ep04-b04.mp3
  python measure-phrases.py out/04-dashboard-tour/ep04-b06.mp3 \
      --text "../scripts/04-dashboard-tour.md:b06" \
      --phrases "hoot" "talons" "roost" "deploy" "activity logs"

--text FILE:beatid pulls the beat's narration from the episode script, so the
char-proportional estimates use the words actually spoken.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate  # noqa: E402


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0


def gaps(path: Path, min_gap: float, noise_db: int):
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path),
         "-af", f"silencedetect=noise={noise_db}dB:d={min_gap}", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    pairs = re.findall(r"silence_start: ([\d.]+).*?silence_end: ([\d.]+)", out, re.S)
    return [(float(a), float(b)) for a, b in pairs]


def beat_text(spec: str) -> str:
    file_part, bid = spec.rsplit(":", 1)
    ep = generate.parse_episode(Path(file_part))
    for b in ep.beats:
        if b.id == bid:
            model_id = generate.resolve_model(ep.meta, None)
            strip = not model_id.lower().startswith("eleven_v3")
            return b.resolved(strip_tags=strip)
    sys.exit(f"beat {bid} not found in {file_part}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("mp3")
    ap.add_argument("--gap", type=float, default=0.25,
                    help="minimum internal silence to report (default %(default)s)")
    ap.add_argument("--noise", type=int, default=-35,
                    help="silence threshold in dB (default %(default)s)")
    ap.add_argument("--text", default="",
                    help="scripts/NN-slug.md:bNN - narration source for char offsets")
    ap.add_argument("--phrases", nargs="*", default=[],
                    help="substrings of the narration to estimate offsets for")
    args = ap.parse_args()

    path = Path(args.mp3)
    total = duration(path)
    print(f"{path.name}: {total:.2f}s")

    found = gaps(path, args.gap, args.noise)
    if found:
        print(f"\ninternal silences >= {args.gap}s (phrase boundaries):")
        for gs, ge in found:
            print(f"  {gs:6.2f}s - {ge:6.2f}s  ({ge - gs:.2f}s)  "
                  f"-> cue the next action at ~{ge:.2f}s")
    else:
        print(f"\nno internal silences >= {args.gap}s - use char offsets")

    if args.phrases:
        if not args.text:
            sys.exit("--phrases needs --text FILE:beatid")
        text = beat_text(args.text)
        # Speech starts after the 250ms lead-in; the char clock runs from there.
        lead = 0.25
        speech = total - lead
        print("\nchar-proportional estimates (lead-in compensated):")
        for phrase in args.phrases:
            i = text.lower().find(phrase.lower())
            if i < 0:
                print(f"  !! '{phrase}' is not in the narration text")
                continue
            at = lead + speech * i / len(text)
            print(f"  '{phrase}' spoken at ~{at:5.2f}s")


if __name__ == "__main__":
    main()
