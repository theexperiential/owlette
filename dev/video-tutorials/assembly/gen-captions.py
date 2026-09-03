"""Generate per-episode SRT captions from the scripts on the manifest grid.

Each spoken beat's narration is split into phrase cues (sentence punctuation,
target <=90 chars) and timed char-proportionally across the beat's
[start_s, start_s + duration_s] slot — the same estimation measure-phrases.py
uses for choreography cues, which proved accurate enough to cue clicks against.
eleven_v3 delivery tags ([warm], [reassuring], ...) are stripped.

  python gen-captions.py            # captions/<stem>.srt at 1.0x
  python gen-captions.py --speed 1.25   # timings divided for sped deliverables

Output: assembly/captions/<stem>[ -SPEED ].srt
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path

VT = Path(__file__).resolve().parent.parent
MANIFESTS = VT / "assembly" / "manifests"
OUT = VT / "assembly" / "captions"

spec = importlib.util.spec_from_file_location("gen", VT / "voiceover" / "generate.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

TAG_RE = re.compile(r"\[[a-z][a-z ]*\]\s*")
MAX_CUE_CHARS = 90


def phrases(text: str) -> list[str]:
    """Sentence-ish chunks, each <= MAX_CUE_CHARS where punctuation allows."""
    text = TAG_RE.sub("", text).replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"(?<=[.!?])\s+|(?<=—)\s+|(?<=:)\s+", text)
    out: list[str] = []
    for part in parts:
        part = part.strip()
        while len(part) > MAX_CUE_CHARS:
            cut = part.rfind(",", 0, MAX_CUE_CHARS)
            if cut < MAX_CUE_CHARS // 2:
                cut = part.rfind(" ", 0, MAX_CUE_CHARS)
            if cut <= 0:
                break
            out.append(part[: cut + 1].strip())
            part = part[cut + 1:].strip()
        if part:
            out.append(part)
    # Merge stub fragments (a wrap can strand a trailing word like "first.")
    # into their neighbour — a sub-second cue flashes unreadably.
    merged: list[str] = []
    for p in out:
        if merged and (len(p) < 20 or len(merged[-1]) < 20) \
                and len(merged[-1]) + len(p) <= MAX_CUE_CHARS + 25:
            merged[-1] = f"{merged[-1]} {p}"
        else:
            merged.append(p)
    return merged


def ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", type=float, default=1.0,
                    help="playback speed of the target video (timings divided)")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    suffix = "" if args.speed == 1.0 else f"-{args.speed:g}x"

    for mpath in sorted(MANIFESTS.glob("*.json")):
        m = json.loads(mpath.read_text(encoding="utf-8"))
        ep = gen.parse_episode(VT / m["script"])
        text_by_beat = {b.id: b.resolved(strip_tags=False) for b in ep.beats}
        cues = []
        for beat in m["beats"]:
            dur = float(beat.get("duration_s") or 0)
            text = text_by_beat.get(beat["id"], "")
            if dur <= 0 or not text:
                continue
            start = float(beat["start_s"])
            ph = phrases(text)
            total_chars = sum(len(p) for p in ph) or 1
            cursor = start
            for p in ph:
                span = dur * len(p) / total_chars
                cues.append((cursor / args.speed, (cursor + span) / args.speed, p))
                cursor += span
        lines = []
        for i, (a, b, p) in enumerate(cues, 1):
            # Leave a 60ms gap so players never merge adjacent cues.
            lines += [str(i), f"{ts(a)} --> {ts(max(a + 0.2, b - 0.06))}", p, ""]
        out = OUT / f"{m['stem']}{suffix}.srt"
        out.write_text("\n".join(lines), encoding="utf-8")
        print(f"{out.name}  {len(cues)} cue(s)")


if __name__ == "__main__":
    main()
