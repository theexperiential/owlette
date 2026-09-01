#!/usr/bin/env python
"""
render-continuous.py - render a whole episode in ONE request, then split it
into per-beat files.

WHY THIS EXISTS

generate.py renders each beat as its own API call, so every beat is a cold take:
the model re-derives timbre and noise floor each time and consecutive clips
audibly switch voice mid-episode. The usual remedy is request stitching, but
eleven_v3 supports neither form:

    "Providing previous_text or next_text is not yet supported with the
     'eleven_v3' model."
    "Providing previous_request_ids or next_request_ids is not yet supported
     with the 'eleven_v3' model."

So the episode is rendered as a single continuous read - one take, one voice,
one noise floor - and cut back into beats afterwards.

HOW THE SPLIT WORKS

Beats are joined with `[pause] [pause] [pause]`, which measures ~3.7s of silence
against ~1.2s for a natural in-script `[pause]` and 0.8s for `<break>` (which v3
ignores). The N-1 LONGEST silences are taken as the cut points rather than
thresholding, because the count is known exactly and a fixed threshold would be
guessing.

Each cut leaves LEAD_MS of silence at the head of the next beat, which is the
lead-in generate.py used to add in a separate re-encode pass - speech starting
on sample zero is audibly clipped on a timeline.

Output is stereo: the narration is mono, and a mono clip on a stereo Resolve
track plays only in the left channel.

An episode whose split does not yield exactly one segment per beat is REFUSED
and left alone - a mis-split desyncs every beat from picture, which is far worse
than an inconsistent voice.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate  # noqa: E402

MARKER = "\n\n[pause] [pause] [pause]\n\n"
# Silence to leave at the head of each beat. Also the tail left on the previous.
LEAD_MS = 250
# A gap must be at least this long to be a candidate cut point.
#
# The marker measures ~3.7s in a short text but shrinks to ~1.0-1.8s inside a
# full episode, and on some episodes below 1.0s entirely - v3 compresses
# repeated pause tags over long input - ep12's markers came out at 0.34-2.0s.
# So the floor is deliberately low and
# selection is POSITIONAL, not by duration: for each beat boundary the text
# predicts, take the nearest gap. Picking the N-1 longest gaps instead refused
# 3 of 16 episodes - twice because the markers were shorter than the floor, once
# because a natural pause outranked a real marker.
MIN_GAP_S = 0.30
# Silence threshold for gap detection. -40dB is right for most takes, but v3
# sometimes renders a marker gap with breath/room tone above it - ep04's fifth
# marker sat at 102.9-103.5s with a floor between -40 and -35dB and was
# invisible at the default. Override per run with --noise; positional selection
# keeps a looser threshold safe, because extra natural-pause candidates lose to
# the marker nearest each expected boundary.
NOISE_DB = -40
# Seconds to discard from the very head of the take before beat 1's cut. v3
# sometimes opens a take with non-speech junk (ep04: a broadband double-pop
# and a falling sweep, ~1.4s, before the first word). Trimming at split time
# is free; a re-render is the fallback if the junk overlaps the first word.
HEAD_TRIM_S = 0.0
# How far a cut may sit from its text-proportional position, as a fraction of
# the whole take. Speech rate varies beat to beat; 12% is loose enough for that
# and tight enough to catch a genuine mis-split.
POSITION_TOLERANCE = 0.12
OUTPUT_FORMAT = "mp3_44100_192"


def ffprobe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0


def find_gaps(path: Path) -> List[Tuple[float, float]]:
    """Every silence >= MIN_GAP_S, as (start, end)."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path),
         "-af", f"silencedetect=noise={NOISE_DB}dB:d={MIN_GAP_S}", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    pairs = re.findall(r"silence_start: ([\d.]+).*?silence_end: ([\d.]+)", out, re.S)
    return [(float(a), float(b)) for a, b in pairs]


def cut(src: Path, dest: Path, start: float, end: float, lead_in: bool = False) -> None:
    """Write [start, end) as stereo 192k, re-encoded so the cut is sample-exact.

    lead_in prepends silence. Only the FIRST beat needs it: every other beat
    inherits its lead-in from the marker gap it was cut out of, but beat one
    starts at 0.0 of the take, where the model begins speaking immediately.
    """
    chain = "pan=stereo|c0=c0|c1=c0"
    if lead_in:
        chain += f",adelay={LEAD_MS}:all=1"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(src),
         "-ss", f"{max(0.0, start):.3f}", "-to", f"{end:.3f}",
         "-af", chain,
         "-c:a", "libmp3lame", "-b:a", "192k", "-y", str(dest)],
        check=True, capture_output=True)


def render_episode(path: Path, out_root: Path, api_key: str, voice_id: str,
                   stability: float, style: float, dry_run: bool,
                   reuse: bool = False) -> bool:
    ep = generate.parse_episode(path)
    model_id = generate.resolve_model(ep.meta, None)
    strip = not model_id.lower().startswith("eleven_v3")

    spoken = [(b.id, b.resolved(strip_tags=strip)) for b in ep.beats]
    spoken = [(bid, t) for bid, t in spoken if t]
    if not spoken:
        print(f"  {ep.slug}: no spoken beats, skipping")
        return True

    combined = MARKER.join(t for _, t in spoken)
    print(f"\n=== episode {ep.number:02d} - {ep.slug} ===")
    print(f"  beats: {len(spoken)}   chars: {len(combined)}   model: {model_id}")
    if dry_run:
        return True

    out_dir = out_root / ep.out_name
    whole = out_dir / "_continuous.mp3"
    if reuse:
        if not whole.is_file():
            # Never fall through to a paid render behind --split-only. This
            # silently re-rendered ep01 once, which cost credits for nothing.
            print(f"  !! --split-only but no {whole.name} to split - skipping")
            return False
        print(f"  reusing the existing take ({whole.name}) - no API call")
        return split_take(ep, spoken, whole, out_dir)

    resp = generate.requests.post(
        f"{generate.API_BASE}/{voice_id}",
        params={"output_format": OUTPUT_FORMAT},
        headers={"xi-api-key": api_key, "Content-Type": "application/json",
                 "Accept": "audio/mpeg"},
        json={"text": combined, "model_id": model_id,
              "voice_settings": {"stability": stability,
                                 "similarity_boost": generate.SIMILARITY_BOOST,
                                 "style": style,
                                 "use_speaker_boost": generate.USE_SPEAKER_BOOST}},
        timeout=600,
    )
    if resp.status_code != 200:
        print(f"  !! HTTP {resp.status_code}: {resp.text[:300]}")
        return False

    out_dir.mkdir(parents=True, exist_ok=True)
    whole.write_bytes(resp.content)
    return split_take(ep, spoken, whole, out_dir)


def split_take(ep, spoken, whole: Path, out_dir: Path) -> bool:
    """Cut one continuous take into per-beat files."""
    total = ffprobe_duration(whole)

    gaps = find_gaps(whole)
    need = len(spoken) - 1
    if len(gaps) < need:
        print(f"  !! only {len(gaps)} gap(s) >= {MIN_GAP_S}s but need {need} - "
              f"REFUSING to split (the take is kept at {whole.name})")
        return False

    # Select by POSITION: walk the expected boundaries and take the nearest
    # unused gap to each. Duration is a weak signal (markers shrink in long
    # input) whereas position is strong - the text says where each beat ends.
    lengths = [len(t) for _, t in spoken]
    total_chars = sum(lengths)
    cuts, used, worst = [], set(), 0.0
    cum = 0
    for k, ln in enumerate(lengths[:-1]):
        cum += ln
        expected = total * cum / total_chars
        candidates = [g for i, g in enumerate(gaps) if i not in used]
        if not candidates:
            print(f"  !! ran out of gaps at cut {k + 1} - REFUSING to split")
            return False
        best = min(candidates, key=lambda g: abs((g[0] + g[1]) / 2 - expected))
        used.add(gaps.index(best))
        mid = (best[0] + best[1]) / 2
        drift = abs(mid - expected) / total
        worst = max(worst, drift)
        if drift > POSITION_TOLERANCE:
            print(f"  !! cut {k + 1} sits {mid:.1f}s but the text puts that beat "
                  f"boundary near {expected:.1f}s ({drift * 100:.0f}% of the take) "
                  f"- REFUSING to split")
            return False
        cuts.append(best)

    if cuts != sorted(cuts):
        print("  !! the chosen cuts are not in time order - REFUSING to split")
        return False
    print(f"  split: {len(cuts)} cut(s), shortest gap {min(g[1] - g[0] for g in cuts):.2f}s, "
          f"worst position drift {worst * 100:.0f}%")

    lead = LEAD_MS / 1000.0
    bounds = []
    start = HEAD_TRIM_S
    if HEAD_TRIM_S > 0:
        print(f"  head trim: beat 1 starts at {HEAD_TRIM_S:.2f}s of the take")
    for gs, ge in cuts:
        bounds.append((start, gs + lead))       # keep a short tail
        start = max(0.0, ge - lead)             # and hand the next beat a lead-in
    bounds.append((start, total))

    # Every cut is verified by reading the written file BACK. Resolve holding a
    # handle on an mp3 once let a rewrite fail while this script reported the
    # episode as a success, which left old and new beats mixed in one episode -
    # the worst possible silent failure. A wrong read-back aborts the episode
    # immediately and says exactly which beats were rewritten before the stop.
    written = []
    for k, ((bid, _), (a, b)) in enumerate(zip(spoken, bounds)):
        dest = out_dir / f"ep{ep.number:02d}-{bid}.mp3"
        expect = (b - a) + (LEAD_MS / 1000.0 if k == 0 else 0.0)
        try:
            cut(whole, dest, a, b, lead_in=(k == 0))
        except subprocess.CalledProcessError as exc:
            err = (exc.stderr or b"").decode(errors="replace").strip().splitlines()
            print(f"  !! FAILED writing {dest.name}: {err[-1] if err else exc}")
            print(f"  !! EPISODE IS NOW MIXED: rewritten so far: "
                  f"{', '.join(written) or 'none'} - re-run --split-only "
                  f"with every mp3 closed (Resolve!) before using this episode")
            return False
        got = ffprobe_duration(dest)
        if abs(got - expect) > 0.25:
            print(f"  !! {dest.name} reads back {got:.2f}s, expected "
                  f"{expect:.2f}s - the write did not take (locked file?)")
            print(f"  !! EPISODE IS NOW MIXED: rewritten so far: "
                  f"{', '.join(written) or 'none'} - re-run --split-only "
                  f"with every mp3 closed (Resolve!) before using this episode")
            return False
        written.append(dest.name)
        print(f"    {dest.name}  {b - a:6.2f}s")
    # The take is KEPT. Re-splitting is free; re-rendering is not, and the
    # split is the part most likely to need another go.
    return True


def main() -> None:
    global NOISE_DB, HEAD_TRIM_S
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("scripts", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=str(generate.DEFAULT_OUT_DIR))
    ap.add_argument("--stability", type=float, default=generate.DEFAULT_STABILITY)
    ap.add_argument("--style", type=float, default=generate.DEFAULT_STYLE)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--split-only", action="store_true",
                    help="re-split an existing _continuous.mp3 without calling the API")
    ap.add_argument("--noise", type=int, default=NOISE_DB,
                    help="silencedetect threshold in dB (default %(default)s); "
                         "raise toward -35 when a marker gap has audible room tone")
    ap.add_argument("--head-trim", type=float, default=HEAD_TRIM_S,
                    help="seconds to discard from the take's head before beat 1 "
                         "(v3 sometimes opens with non-speech junk)")
    args = ap.parse_args()
    NOISE_DB = args.noise
    HEAD_TRIM_S = args.head_trim

    generate.load_env()
    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "")
    if not args.dry_run and not (api_key and voice_id):
        sys.exit("ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required")

    paths = ([sorted(generate.DEFAULT_SCRIPTS_DIR.glob("*.md"))] if args.all
             else [[Path(p) for p in args.scripts]])[0]
    if not paths:
        sys.exit("pass script path(s) or --all")

    ok, bad = 0, []
    for p in paths:
        if render_episode(p, Path(args.out), api_key, voice_id,
                          args.stability, args.style, args.dry_run,
                          reuse=args.split_only):
            ok += 1
        else:
            bad.append(p.stem)
    print(f"\n{ok} episode(s) rendered; {len(bad)} refused" +
          (": " + ", ".join(bad) if bad else ""))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
