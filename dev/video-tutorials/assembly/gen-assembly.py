#!/usr/bin/env python3
"""Generate per-episode assembly sheets for the Resolve edit.

For each episode: parse the script's beats (via voiceover/generate.py's own
parser so the beat model can't drift), ffprobe each rendered MP3, and emit a
markdown sheet with per-beat durations, cumulative narration timecodes, and the
footage source for the editor.
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO = Path(r"c:\Users\admin\Documents\Git\Owlette")
VT = REPO / "dev" / "video-tutorials"
SCRIPTS = VT / "scripts"
OUT_AUDIO = VT / "voiceover" / "out"
DEST = VT / "assembly"

spec = importlib.util.spec_from_file_location("gen", VT / "voiceover" / "generate.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

# Footage source per episode number (web scene files use the NN-slug of the scene).
WEB = "web/e2e/.output/videos/{stem}.mp4"
FOOTAGE = {
    1: [WEB], 2: [WEB], 4: [WEB], 5: [WEB], 6: [WEB], 7: [WEB], 10: [WEB],
    11: [WEB], 12: [WEB], 13: [WEB], 14: [WEB], 15: [WEB],
    8: [WEB, "web/e2e/.output/videos/08-remote-actions-b08-member.mp4 (b08 member cut)"],
    17: [WEB, "web/e2e/.output/videos/17-fleet-maintenance-b06-tokens.mp4 (b06 tokens cut)"],
    3: ["native: capture-native install wizard (b01-b04)",
        "desktop: web/e2e/.output/desktop-videos (pairing dialog, b05-b06/b10)",
        WEB + " (dashboard beats b07-b09)"],
    9: ["desktop: web/e2e/.output/desktop-videos (window beats)",
        "native: tray segments (capture-tray-menu.ps1 + icon states)"],
    16: [WEB, "desktop: report-issue segment (b07 half)"],
}


def probe(mp3: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(mp3)],
        capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def main() -> None:
    DEST.mkdir(exist_ok=True)
    index_rows = []
    for path in sorted(SCRIPTS.glob("*.md")):
        ep = gen.parse_episode(path)
        model = gen.resolve_model(ep.meta, None)
        strip = not model.lower().startswith("eleven_v3")
        audio_dir = OUT_AUDIO / ep.out_name
        rows, cursor, missing = [], 0.0, 0
        for b in ep.beats:
            text = b.resolved(strip_tags=strip)
            if not text:
                rows.append((b.id, b.title, "—", "b-roll (no VO)", "", ""))
                continue
            mp3 = audio_dir / f"ep{ep.number:02d}-{b.id}.mp3"
            if not mp3.exists():
                rows.append((b.id, b.title, mp3.name, "MISSING", "", ""))
                missing += 1
                continue
            d = probe(mp3)
            rows.append((b.id, b.title, mp3.name, f"{d:.1f}s", mmss(cursor), mmss(cursor + d)))
            cursor += d
        stem = ep.out_name
        sources = [s.format(stem=stem) for s in FOOTAGE.get(ep.number, [WEB])]
        sheet = DEST / f"{stem}.md"
        lines = [
            f"# assembly — episode {ep.number:02d}: {ep.meta.get('title', ep.slug)}",
            "",
            f"Narration: **{mmss(cursor)}** across {sum(1 for r in rows if r[3] not in ('MISSING',) and r[2] != '—')} spoken beats"
            + (f" — **{missing} MP3 MISSING**" if missing else "") + ".",
            "Timecodes assume beats butt-jointed in order; add breathing room per taste and",
            "re-read the SCREEN notes in the script for zoom/callout direction.",
            "",
            "Footage:",
            *[f"- {s}" for s in sources],
            "",
            "| beat | title | mp3 | length | vo start | vo end |",
            "|---|---|---|---|---|---|",
            *[f"| {r[0]} | {r[1]} | `{r[2]}` | {r[3]} | {r[4]} | {r[5]} |" for r in rows],
            "",
        ]
        sheet.write_text("\n".join(lines), encoding="utf-8")
        index_rows.append((ep.number, ep.meta.get("title", ep.slug), stem, mmss(cursor)))
        print(f"  {sheet.name}: {mmss(cursor)} narration")

    idx = [
        "# assembly sheets",
        "",
        "One sheet per episode: every beat's rendered MP3 length and its cumulative",
        "narration timecode, plus where the footage lives. Regenerate after any",
        "re-voice with `python <scratchpad>/gen-assembly.py` (reads the scripts and",
        "manifests; makes no API calls).",
        "",
        "| ep | title | sheet | narration |",
        "|---|---|---|---|",
        *[f"| {n:02d} | {t} | [{s}.md]({s}.md) | {d} |" for n, t, s, d in sorted(index_rows)],
        "",
    ]
    (DEST / "README.md").write_text("\n".join(idx), encoding="utf-8")
    print(f"wrote {len(index_rows)} sheets + README to {DEST}")


if __name__ == "__main__":
    main()
