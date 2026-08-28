#!/usr/bin/env python3
"""Generate per-episode assembly sheets + Resolve build manifests.

For each episode: parse the script's beats (via voiceover/generate.py's own
parser so the beat model can't drift), ffprobe each rendered MP3 and every
footage file, and emit

  * `assembly/NN-slug.md`            — the human sheet (per-beat durations,
                                       cumulative narration timecodes, footage)
  * `assembly/manifests/NN-slug.json` — the machine sheet consumed by
                                       `resolve/build_episode.py`, which builds
                                       the episode timeline inside DaVinci
                                       Resolve (free edition).

The JSON manifest carries absolute paths, so it is written for the machine that
generated it. It is a build artifact: regenerate after a re-voice or a re-capture
rather than hand-editing it.

Usage
-----
    python gen-assembly.py
    python gen-assembly.py --media-root c:\\Users\\me\\Documents\\Git\\Owlette

`--media-root` (or `$OWLETTE_MEDIA_ROOT`) is where the *build outputs* live —
`voiceover/out/` MP3s and `footage/` takes. Both are gitignored, so a
git worktree has neither; point this at the main checkout when running from one.
Scripts and the emitted sheets always resolve against this file's own tree.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional

# This file's own tree — the scripts we read and the sheets we write.
VT = Path(__file__).resolve().parent.parent
REPO = VT.parent.parent
SCRIPTS = VT / "scripts"
DEST = VT / "assembly"
MANIFESTS = DEST / "manifests"

spec = importlib.util.spec_from_file_location("gen", VT / "voiceover" / "generate.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

# ---------------------------------------------------------------------------
# Direction lines
#
# generate.py's parser DROPS every direction line (that is its job — only the
# voiceover reaches ElevenLabs). The editor needs the opposite half, so re-read
# each beat block here and keep the direction. Both label tuples are imported
# from generate.py rather than re-declared, so the two halves cannot disagree
# about what counts as direction.
# ---------------------------------------------------------------------------
DIRECTION_RE = re.compile(
    r"^(" + "|".join(re.escape(lbl) for lbl in gen.DIRECTION_LABELS) + r")\s*(.*)$"
)
# What a beat's marker note leads with, best first: an explicit SCREEN
# direction, else the B-ROLL / ON-SCREEN line standing in for it.
SCREEN_PRIORITY = ("**SCREEN:**", "**B-ROLL:**", "**ON-SCREEN:**")

# ---------------------------------------------------------------------------
# Footage
#
# role "scene" — belongs on V1, appended in the order listed.
# role "pool"  — imported to the media pool but NOT auto-placed: alternate cuts
#                and inserts the editor drops by hand.
# A `path` of None is footage that has to be shot before this episode can cut.
# ---------------------------------------------------------------------------
SCENE = "dev/video-tutorials/footage/web/{stem}.mp4"
CUT = "dev/video-tutorials/footage/web/{stem}-{cut}.mp4"
DESKTOP = "dev/video-tutorials/footage/desktop/{name}"
# Generated or licensed b-roll — not a harness capture, so its `.beats.json`
# is hand-authored and the pixel gates in vet-recordings.py do not apply.
BROLL = "dev/video-tutorials/b-roll/{name}"


class Source(NamedTuple):
    role: str  # "scene" | "pool"
    path: Optional[str]  # repo-relative template, or None if not yet captured
    note: str


def web(note: str = "") -> Source:
    return Source("scene", SCENE, note)


FOOTAGE: Dict[int, List[Source]] = {
    # b02 is its own take: the landing wordmark then the cut to the fleet, which
    # the main scene (authenticated, never leaves /dashboard) cannot contain.
    # "pool" keeps it off the butt-joint fallback's V1; the conform still uses it,
    # filling only the beats the scene take does not claim.
    1: [
        web(),
        Source("pool", CUT.format(stem="{stem}", cut="b02"), "b02 wordmark + fleet"),
        Source("pool", BROLL.format(name="01-b01-cold-open.mp4"),
               "b01 cold-open montage (generated b-roll: exhibit / lobby / control room)"),
    ],
    2: [web()],
    4: [web()],
    5: [web()],
    6: [web()],
    7: [web()],
    10: [web()],
    11: [web()],
    12: [web()],
    13: [web()],
    14: [web()],
    15: [web()],
    8: [
        web(),
        Source("pool", CUT.format(stem="{stem}", cut="b08-member"), "b08 member cut"),
    ],
    17: [
        web(),
        Source("pool", CUT.format(stem="{stem}", cut="b06-tokens"), "b06 tokens cut"),
    ],
    3: [
        Source("scene", None, "native: capture-native install wizard (b01-b04)"),
        Source(
            "scene",
            DESKTOP.format(name="03-install-and-pair-desktop.mp4"),
            "pairing dialog (b05-b06/b10)",
        ),
        web("dashboard + /add beats b02, b07-b09"),
    ],
    9: [
        Source(
            "scene",
            DESKTOP.format(name="09-the-owlette-app.mp4"),
            "window beats",
        ),
        Source(
            "pool",
            DESKTOP.format(name="09-the-owlette-app-unpaired.mp4"),
            "unpaired-state alt",
        ),
        Source("scene", None, "native: tray segments (capture-tray-menu.ps1 + icon states)"),
    ],
    16: [
        web(),
        Source(
            "pool",
            DESKTOP.format(name="16-report-issue-desktop.mp4"),
            "report-issue segment (b07 half)",
        ),
    ],
}

# The delivery format. Every capture harness records 60fps; the web scenes are
# 1920x1080 and the desktop takes 1600x900, so the timeline is 1080p and the
# smaller desktop takes are scaled up inside it (see resolve/README.md).
TIMELINE_WIDTH = 1920
TIMELINE_HEIGHT = 1080
TIMELINE_FPS = 60.0


def ffprobe(path: Path, entries: str) -> Dict[str, str]:
    """Run ffprobe and return its `key=value` lines as a dict ({} on failure)."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", *entries.split(), "-of", "default=nw=1", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}
    out: Dict[str, str] = {}
    for line in r.stdout.splitlines():
        key, _, value = line.partition("=")
        if value and value != "N/A":
            out[key.strip()] = value.strip()
    return out


def probe(mp3: Path) -> float:
    """Duration of an audio file, in seconds."""
    data = ffprobe(mp3, "-show_entries format=duration")
    return float(data.get("duration", 0.0))


def probe_video(path: Path) -> Dict[str, object]:
    """Duration + video-stream shape, for the timeline-format decision."""
    data = ffprobe(
        path,
        "-select_streams v:0 -show_entries stream=width,height,r_frame_rate "
        "-show_entries format=duration",
    )
    if not data:
        return {}
    out: Dict[str, object] = {}
    if "duration" in data:
        out["duration_s"] = round(float(data["duration"]), 3)
    for key in ("width", "height"):
        if key in data:
            out[key] = int(data[key])
    rate = data.get("r_frame_rate", "")
    if "/" in rate:
        num, _, den = rate.partition("/")
        if float(den):
            out["fps"] = round(float(num) / float(den), 3)
    return out


def parse_directions(block: str) -> Dict[str, str]:
    """Pull the direction lines out of one beat block.

    Returns {label_without_markup: text}, e.g. {"SCREEN": "...", "NOTE": "..."}.
    A direction runs until the next direction label, the `**VOICEOVER:**` label,
    or the end of the beat — so a wrapped direction line is kept whole.
    """
    found: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for raw in block.splitlines():
        line = raw.strip()
        if line.startswith(gen.VOICEOVER_LABEL):
            break  # everything past here is spoken text, not direction
        m = DIRECTION_RE.match(line)
        if m:
            current = m.group(1).strip("*:").strip()
            found.setdefault(current, []).append(m.group(2).strip())
            continue
        if current and line and not line.startswith("**"):
            found[current].append(line)  # wrapped continuation of the direction
        elif not line:
            current = None
    return {k: re.sub(r"\s+", " ", " ".join(v)).strip() for k, v in found.items() if any(v)}


def beat_blocks(path: Path) -> Dict[str, str]:
    """{beat_id: raw block text} using generate.py's own beat heading regex."""
    _, body = gen.parse_front_matter(path.read_text(encoding="utf-8"))
    matches = list(gen.BEAT_HEADING_RE.finditer(body))
    blocks: Dict[str, str] = {}
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        blocks[m.group(1)] = body[m.end() : end]
    return blocks


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def resolve_sources(number: int, stem: str, media_root: Path) -> List[Dict[str, object]]:
    """Turn this episode's FOOTAGE rows into concrete, probed source records."""
    out: List[Dict[str, object]] = []
    for src in FOOTAGE.get(number, [web()]):
        rec: Dict[str, object] = {"role": src.role, "note": src.note}
        if src.path is None:
            rec.update({"path": None, "exists": False, "rel": None})
            out.append(rec)
            continue
        rel = src.path.format(stem=stem)
        full = (media_root / rel).resolve()
        rec.update({"rel": rel, "path": str(full), "exists": full.exists()})
        if full.exists():
            rec.update(probe_video(full))
        out.append(rec)
    return out


def build_episode_record(
    path: Path, media_root: Path, out_audio: Path
) -> Dict[str, object]:
    """Parse one script into the record both the sheet and the manifest render."""
    ep = gen.parse_episode(path)
    model = gen.resolve_model(ep.meta, None)
    strip = not model.lower().startswith("eleven_v3")
    blocks = beat_blocks(path)
    audio_dir = out_audio / ep.out_name

    beats: List[Dict[str, object]] = []
    cursor = 0.0
    for b in ep.beats:
        directions = parse_directions(blocks.get(b.id, ""))
        screen = next(
            (directions[lbl.strip("*:")] for lbl in SCREEN_PRIORITY if directions.get(lbl.strip("*:"))),
            "",
        )
        rec: Dict[str, object] = {
            "id": b.id,
            "title": b.title,
            "screen_note": screen,
            "direction": directions,
            "start_s": round(cursor, 3),
            "start_frame": int(round(cursor * TIMELINE_FPS)),
        }
        text = b.resolved(strip_tags=strip)
        if not text:
            # A b-roll beat: no MP3, no time on the A1 track, but it still earns
            # a marker so the direction reaches the editor.
            rec.update({"spoken": False, "mp3": None, "duration_s": None, "status": "b-roll (no VO)"})
            beats.append(rec)
            continue
        mp3 = audio_dir / f"ep{ep.number:02d}-{b.id}.mp3"
        if not mp3.exists():
            rec.update(
                {"spoken": True, "mp3": None, "mp3_name": mp3.name, "duration_s": None, "status": "MISSING"}
            )
            beats.append(rec)
            continue
        d = probe(mp3)
        rec.update(
            {
                "spoken": True,
                "mp3": str(mp3.resolve()),
                "mp3_name": mp3.name,
                "duration_s": round(d, 3),
                "duration_frames": int(round(d * TIMELINE_FPS)),
                "status": "ok",
            }
        )
        cursor += d
        beats.append(rec)

    sources = resolve_sources(ep.number, ep.out_name, media_root)
    return {
        "episode": ep.number,
        "slug": ep.slug,
        "stem": ep.out_name,
        "title": ep.meta.get("title", ep.slug),
        "capture": ep.meta.get("capture"),
        "scenario": ep.meta.get("scenario"),
        # Provenance, kept tree-relative so a manifest generated from a git
        # worktree does not bake that worktree's path into the committed file.
        # Media paths below stay absolute — Resolve needs to open them.
        "script": path.resolve().relative_to(VT).as_posix(),
        "media_root": str(media_root),
        "narration_s": round(cursor, 3),
        "timeline": {
            "width": TIMELINE_WIDTH,
            "height": TIMELINE_HEIGHT,
            "fps": TIMELINE_FPS,
        },
        "sources": sources,
        "beats": beats,
    }


def write_sheet(record: Dict[str, object]) -> None:
    beats: List[Dict[str, object]] = record["beats"]  # type: ignore[assignment]
    sources: List[Dict[str, object]] = record["sources"]  # type: ignore[assignment]
    missing = sum(1 for b in beats if b.get("status") == "MISSING")
    spoken = sum(1 for b in beats if b.get("status") == "ok")
    total = float(record["narration_s"])  # type: ignore[arg-type]

    rows = []
    cursor = 0.0
    for b in beats:
        d = b.get("duration_s")
        if d is None:
            rows.append((b["id"], b["title"], b.get("mp3_name", "—"), b["status"], "", ""))
            continue
        rows.append(
            (b["id"], b["title"], b["mp3_name"], f"{float(d):.1f}s", mmss(cursor), mmss(cursor + float(d)))
        )
        cursor += float(d)

    src_lines = []
    for s in sources:
        flag = "" if s["exists"] else (" — **not captured yet**" if s["rel"] is None else " — **MISSING**")
        label = s["rel"] or s["note"]
        extra = f" — {s['note']}" if s["rel"] and s["note"] else ""
        shape = ""
        if s.get("width"):
            shape = f" [{s['width']}x{s['height']} @ {s.get('fps', '?')}fps]"
        src_lines.append(f"- `{label}`{extra}{shape}{flag}" if s["rel"] else f"- {label}{flag}")

    tl = record["timeline"]
    lines = [
        f"# assembly — episode {record['episode']:02d}: {record['title']}",
        "",
        f"Narration: **{mmss(total)}** across {spoken} spoken beats"
        + (f" — **{missing} MP3 MISSING**" if missing else "")
        + ".",
        "Timecodes assume beats butt-jointed in order; add breathing room per taste and",
        "re-read the SCREEN notes in the script for zoom/callout direction.",
        "",
        f"Timeline: {tl['width']}x{tl['height']} @ {tl['fps']}fps.",
        f"Resolve build manifest: [`manifests/{record['stem']}.json`](manifests/{record['stem']}.json)",
        "",
        "Footage:",
        *src_lines,
        "",
        "| beat | title | mp3 | length | vo start | vo end |",
        "|---|---|---|---|---|---|",
        *[f"| {r[0]} | {r[1]} | `{r[2]}` | {r[3]} | {r[4]} | {r[5]} |" for r in rows],
        "",
    ]
    (DEST / f"{record['stem']}.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--media-root",
        default=os.environ.get("OWLETTE_MEDIA_ROOT", str(REPO)),
        help="repo root holding voiceover/out MP3s + dev/video-tutorials/footage takes "
        "(default: this file's own checkout, or $OWLETTE_MEDIA_ROOT)",
    )
    args = parser.parse_args()
    media_root = Path(args.media_root).resolve()
    out_audio = media_root / "dev" / "video-tutorials" / "voiceover" / "out"

    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    if not out_audio.exists():
        print(f"!! no voiceover output at {out_audio} — pass --media-root", file=sys.stderr)

    DEST.mkdir(exist_ok=True)
    MANIFESTS.mkdir(exist_ok=True)
    index_rows = []
    for path in sorted(SCRIPTS.glob("*.md")):
        record = build_episode_record(path, media_root, out_audio)
        write_sheet(record)
        (MANIFESTS / f"{record['stem']}.json").write_text(
            json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        beats: List[Dict[str, object]] = record["beats"]  # type: ignore[assignment]
        sources: List[Dict[str, object]] = record["sources"]  # type: ignore[assignment]
        missing_mp3 = sum(1 for b in beats if b.get("status") == "MISSING")
        missing_src = sum(1 for s in sources if not s["exists"])
        flags = "".join(
            [f"  !! {missing_mp3} mp3 missing" if missing_mp3 else "",
             f"  !! {missing_src} source(s) not on disk" if missing_src else ""]
        )
        index_rows.append(
            (record["episode"], record["title"], record["stem"], mmss(float(record["narration_s"])))
        )
        print(f"  {record['stem']}: {mmss(float(record['narration_s']))} narration{flags}")

    idx = [
        "# assembly sheets",
        "",
        "One sheet per episode: every beat's rendered MP3 length and its cumulative",
        "narration timecode, plus where the footage lives. Regenerate after any",
        "re-voice with `python gen-assembly.py` from this directory (reads the scripts",
        "and rendered audio; makes no API calls).",
        "",
        "Each sheet has a machine-readable twin in [`manifests/`](manifests/) that",
        "[`resolve/build_episode.py`](resolve/README.md) turns into a built Resolve",
        "timeline — footage on V1, per-beat narration on A1, a marker per beat carrying",
        "its SCREEN direction.",
        "",
        "| ep | title | sheet | narration |",
        "|---|---|---|---|",
        *[f"| {n:02d} | {t} | [{s}.md]({s}.md) | {d} |" for n, t, s, d in sorted(index_rows)],
        "",
    ]
    (DEST / "README.md").write_text("\n".join(idx), encoding="utf-8")
    print(f"wrote {len(index_rows)} sheets + {len(index_rows)} manifests to {DEST}")


if __name__ == "__main__":
    main()
