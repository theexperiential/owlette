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

The target is not a delivery level, it is the MEDIAN of the episodes' own
current loudness - the level the majority of the series already sits at. That
choice minimises how many files are touched (an episode already at the median
is left bit-for-bit alone) and survives outliers in either direction: a
freshly re-split episode measuring loud, or an accidentally double-gained one
measuring quiet, both get corrected toward the series instead of dragging the
series toward themselves. Normalising up to a delivery level like -16 LUFS is
still not possible here without compression - the raw true peaks sit near
-1 dBTP - so any BOOST is capped so the true peak never exceeds -1 dBTP. The
final export sets delivery level anyway.

IDEMPOTENCE. The gain for an episode is measured against its CURRENT BEATS,
concatenated. An episode already at the target computes ~0 and is skipped; a
freshly re-split episode (raw, un-gained beats) computes the full correction.
Running this script twice is therefore safe - the second run is a no-op - and
a re-split episode heals on the next run without any bookkeeping. Gains inside
SKIP_DB of zero are left alone: they are measurement noise, and a 192k
re-encode generation costs more than 0.2 dB of match buys.

(The original scheme - target = the quietest take, attenuation only - assumed
a fresh, never-normalized corpus and measured the untouched take rather than
the beats. That pair of choices is what made the script non-idempotent: the
measurement never saw what had been applied, so a second run stacked the same
gain again. ep07 was double-gained exactly that way.)
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Optional, Tuple

# |gain| below this is not applied. A 192k re-encode generation measurably
# LOSES ~0.26 dB of integrated loudness on this material (verified 2026-08-31:
# a +0.24 dB correction pass left every episode exactly where it started), so
# a correction smaller than that loss cannot land - the encode eats it and the
# file just accumulates generations. The threshold sits above the loss; the
# ~0.3 dB residual spread it tolerates is far below audibility.
SKIP_DB = 0.35

BEAT_RE = re.compile(r"ep\d{2}-b\d{2}\.mp3\Z")


def episode_beats(ep_dir: Path) -> List[Path]:
    """Only real beat files - a stray ep03-b01.g.mp3 once polluted a glob."""
    return sorted(p for p in ep_dir.iterdir() if BEAT_RE.fullmatch(p.name))


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


def measure_beats(beats: List[Path]) -> Optional[Tuple[float, float]]:
    """Integrated loudness of the beats as one program, via the concat demuxer."""
    lines = "".join("file '%s'\n" % str(b.resolve()).replace("\\", "/")
                    for b in beats)
    fd, listfile = tempfile.mkstemp(suffix=".txt", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(lines)
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "concat", "-safe", "0",
             "-i", listfile,
             "-af", "loudnorm=I=-16:TP=-1.0:LRA=11:print_format=json",
             "-f", "null", "-"],
            capture_output=True, text=True).stderr
    finally:
        try:
            os.unlink(listfile)
        except OSError:
            pass
    m = re.search(r"\{[^{}]*input_i[^{}]*\}", out, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        return float(d["input_i"]), float(d["input_tp"])
    except (ValueError, KeyError):
        return None


def apply_gain(path: Path, gain_db: float) -> bool:
    # The os.replace retries exist because freshly-written mp3s can be briefly
    # locked by the indexer/AV (WinError 5 hit 4 of 7 files once, seconds after
    # a split, with Resolve closed) - and a PARTIAL gain pass leaves an episode
    # internally mixed, which the per-episode idempotent measure cannot then
    # repair. Retry the rename a few times before declaring failure.
    tmp = path.with_suffix(".gain.mp3")
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path),
             "-af", "volume=%.2fdB" % gain_db,
             "-c:a", "libmp3lame", "-b:a", "192k", "-y", str(tmp)],
            check=True, capture_output=True)
        last_exc = None
        for attempt in range(4):
            try:
                os.replace(tmp, path)
                return True
            except OSError as exc:
                last_exc = exc
                time.sleep(1.0 + attempt)
        # A rename needs DELETE access, which an open media-player handle
        # denies indefinitely - while plain WRITES are still shared (the
        # splitter's direct ffmpeg writes succeed on the same files). So
        # replace the CONTENT in place instead of the name.
        try:
            data = tmp.read_bytes()
            with open(path, "r+b") as fh:
                fh.truncate(0)
                fh.write(data)
            tmp.unlink()
            print("    (%s: replaced in place - rename was locked)" % path.name)
            return True
        except OSError:
            raise last_exc
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

    # Pass 1 - where does each episode sit NOW?
    beats_loud = {}
    for ep_dir in episodes:
        beats = episode_beats(ep_dir)
        if not beats:
            continue
        b = measure_beats(beats)
        if b is None:
            print("  %s: could not measure beats - skipped" % ep_dir.name)
            failures.append(ep_dir.name)
            continue
        beats_loud[ep_dir] = b
    if not beats_loud:
        sys.exit("nothing could be measured")

    target = statistics.median(i for i, _ in beats_loud.values())
    spread = (max(i for i, _ in beats_loud.values())
              - min(i for i, _ in beats_loud.values()))
    print("target %.2f LUFS (series median); current beat spread %.2f dB\n"
          % (target, spread))

    # Pass 2 - one gain per episode, applied to all of its beats.
    moved = 0
    for ep_dir in episodes:
        if ep_dir not in beats_loud:
            continue
        beats = episode_beats(ep_dir)
        loud, peak = beats_loud[ep_dir]
        gain = target - loud
        if gain > 0:
            # A boost may not push the true peak past -1 dBTP.
            gain = min(gain, max(0.0, -1.0 - peak))
        state = "skip" if abs(gain) < SKIP_DB else "apply"
        print("  %-28s beats %7.2f LUFS  peak %6.2f dBTP  -> gain %+.2f dB  [%s, %d beats]"
              % (ep_dir.name, loud, peak, gain, state, len(beats)))
        if args.dry_run or state == "skip":
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
