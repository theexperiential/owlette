#!/usr/bin/env python
"""
normalize-levels.py - match perceived loudness ACROSS episodes without
disturbing the balance WITHIN one.

Each episode is a single continuous take (render-continuous.py), so its beats
already share a voice, a noise floor and a level relationship. Normalising each
BEAT on its own would throw that away: a deliberately quieter line would be
lifted to match a louder one and the episode would sound like separate takes
again - the exact problem the continuous render fixed.

So loudness is measured ONCE per episode and a SINGLE gain is applied to all of
its beats. Relative dynamics inside the episode are untouched; only the
episode-to-episode offset moves.

The target is not a delivery level, it is the QUIETEST episode's own loudness,
so every adjustment is an attenuation. Normalising up to something like
-16 LUFS is not possible here without compression: the true peaks already sit
near -1 dBTP, so a ceiling-capped gain moves most episodes less than 0.3 dB and
leaves the spread almost untouched. Matching downward costs only level - which
the final export sets anyway - and leaves the voice alone.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple


def measure(path: Path) -> Optional[Tuple[float, float]]:
    """Integrated loudness and true peak, from loudnorm's analysis pass."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path),
         "-af", "loudnorm=I=-16:TP=-1.0:LRA=11:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True).stderr
    m = re.search(r"\{[^{}]*input_i[^{}]*\}", out, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        return float(d["input_i"]), float(d["input_tp"])
    except (ValueError, KeyError):
        return None


def apply_gain(path: Path, gain_db: float) -> bool:
    tmp = path.with_suffix(".gain.mp3")
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path),
             "-af", "volume=%.2fdB" % gain_db,
             "-c:a", "libmp3lame", "-b:a", "192k", "-y", str(tmp)],
            check=True, capture_output=True)
        os.replace(tmp, path)
        return True
    except (OSError, subprocess.CalledProcessError) as exc:
        print("    !! %s: %s" % (path.name, str(exc).splitlines()[0]))
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        return False


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "out"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.out)
    # Only real episodes: "_retired-*" and scratch directories are not part of
    # the series and would drag the target around.
    episodes = sorted(d for d in root.iterdir()
                      if d.is_dir() and not d.name.startswith("_"))
    if not episodes:
        sys.exit("no episode directories under %s" % root)

    failures = []

    # Pass 1 - measure, so the target can be the quietest episode.
    measured = {}
    for ep_dir in episodes:
        beats = sorted(ep_dir.glob("ep*-b*.mp3"))
        if not beats:
            continue
        take = ep_dir / "_continuous.mp3"
        ref = take if take.is_file() else beats[0]
        m = measure(ref)
        if m:
            measured[ep_dir] = m
        else:
            print("  %s: could not measure - skipped" % ep_dir.name)
            failures.append(ep_dir.name)
    if not measured:
        sys.exit("nothing could be measured")

    target = min(i for i, _ in measured.values())
    spread = max(i for i, _ in measured.values()) - target
    print("target %.2f LUFS (the quietest episode); spread was %.2f dB\n" % (target, spread))

    # Pass 2 - one gain per episode, applied to all of its beats.
    moved = 0
    for ep_dir in episodes:
        if ep_dir not in measured:
            continue
        beats = sorted(ep_dir.glob("ep*-b*.mp3"))
        loud, peak = measured[ep_dir]
        gain = target - loud            # always <= 0, so nothing can clip
        print("  %-28s %7.2f LUFS  peak %6.2f dBTP  -> gain %+.2f dB  (%d beats)"
              % (ep_dir.name, loud, peak, gain, len(beats)))
        if args.dry_run or abs(gain) < 0.05:
            continue
        for b in beats:
            if apply_gain(b, gain):
                moved += 1
            else:
                failures.append(b.name)

    print("\n%d file(s) adjusted; %d failure(s)" % (moved, len(failures)))
    if failures:
        print("  " + ", ".join(failures[:10]))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
