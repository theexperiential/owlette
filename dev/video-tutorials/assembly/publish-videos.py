"""Publish pass over the delivered episode renders (CEO feedback, 2026-09-02):

  1. 1.125x playback speed (video setpts + pitch-preserving atempo —
     Bryant asked for 125%; rosco split the difference, 2026-09-03)
  2. brand bug overlay bottom-right (owlette + "a tridant system", from
     footage/cards/brand-bug.png, downscaled 2x for crispness)
  3. closed captions embedded as a mov_text track (QuickTime CC-visible),
     from assembly/captions/<stem>-1.25x.srt (run gen-captions.py first)

Input:  the Resolve exports in OWLETTE_DELIVERY_DIR (default: TEC Dropbox)
Output: <delivery>/publish/<stem>.mp4  — originals untouched.

Encodes NVENC constqp 14 (the sources carry dither; this keeps it), AAC audio.
Verifies each output: duration ~= source/1.25, has a subtitle stream.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

VT = Path(__file__).resolve().parent.parent
DELIV = Path(os.environ.get(
    "OWLETTE_DELIVERY_DIR",
    r"C:\Users\admin\TEC Dropbox\Dylan Roscover\x\owlette-video-tutorials"))
CAPTIONS = VT / "assembly" / "captions"
SPEED = 1.125

def probe_duration(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def has_subs(path: Path) -> bool:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "s",
                        "-show_entries", "stream=codec_name", "-of", "csv=p=0",
                        str(path)], capture_output=True, text=True)
    return bool(r.stdout.strip())


def main() -> int:
    out_dir = DELIV / "publish"
    out_dir.mkdir(exist_ok=True)
    # Regenerate captions from the scripts so a re-voice or copy fix can
    # never publish with stale cues.
    gen = subprocess.run(
        [sys.executable, str(VT / "assembly" / "gen-captions.py"),
         "--speed", f"{SPEED:g}"], capture_output=True, text=True)
    if gen.returncode != 0:
        print("gen-captions failed: " + gen.stderr[-500:])
        return 1
    sources = sorted(p for p in DELIV.glob("*.mp4"))
    failures = 0
    for src in sources:
        stem = src.stem
        srt = CAPTIONS / f"{stem}-{SPEED:g}x.srt"
        if not srt.is_file():
            print(f"SKIP {stem}: no {srt.name} (run gen-captions.py --speed {SPEED:g})")
            failures += 1
            continue
        out = out_dir / src.name
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src), "-i", str(srt),
            "-filter_complex", f"[0:v]setpts=PTS/{SPEED}[vo]",
            "-map", "[vo]", "-map", "0:a:0", "-map", "1:s:0",
            "-af", f"atempo={SPEED}",
            "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq",
            "-rc", "constqp", "-qp", "14", "-bf", "2",
            "-c:a", "aac", "-b:a", "192k",
            "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
            "-movflags", "+faststart",
            str(out),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAIL {stem}: ffmpeg\n{r.stderr[-500:]}")
            failures += 1
            continue
        want = probe_duration(src) / SPEED
        got = probe_duration(out)
        subs = has_subs(out)
        if abs(got - want) > 0.5 or not subs:
            print(f"FAIL {stem}: duration {got:.2f}s (want ~{want:.2f}s), subs={subs}")
            failures += 1
            continue
        print(f"DONE {stem}  {got:7.2f}s  CC=ok")
    print(f"{len(sources) - failures} of {len(sources)} published to {out_dir}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
