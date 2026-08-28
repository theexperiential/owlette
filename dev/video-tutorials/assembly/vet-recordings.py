"""Vet every recording against its manifest + sidecar before assembly.

Three gates per footage file, mirroring what the record harness enforces:

1. EDGES  - outermost left/bottom pixel strips must match inner reference
            strips (the 7-8px desktop-in-frame bug class), sampled at 25/50/80%
            of the file's duration, plus a peak-luminance content check so an
            all-black capture can't pass. DELIBERATELY stricter than the in-run
            assert: a one-edge deviation only warns during recording (it can be
            legitimate content) but FAILS this gate - the batch gate forces an
            eyeball instead of shipping a maybe.
2. BEATS  - the `<footage>.beats.json` sidecar must exist and every beat's
            measured videoSec must cover its narration mp3Sec.
3. LENGTH - container duration must cover the last sidecar beat's end.

Per episode, also checks that every manifest beat with narration has picture
SOMEWHERE across the episode's sidecars (gaps are listed - some are expected,
e.g. ep03's installer-wizard beats until the VM exists).

Usage:  python vet-recordings.py [NN ...]   (no args = all episodes)
Exit 0 only if every present footage file passes all three gates.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ASSEMBLY = Path(__file__).resolve().parent
MANIFESTS = ASSEMBLY / "manifests"
EDGE_TOLERANCE = 20  # same threshold as assertEdgesClean in the harness


def ffprobe_duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def edge_strip(path, at_sec, vf):
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(at_sec), "-i", str(path),
         "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True)
    return r.stdout[0] if r.stdout else None


def check_edges(path, duration):
    """Multi-point edge audit, same thresholds as assertEdgesClean in the
    harness: contamination is constant so ANY dirty sample condemns the file;
    an all-black take (nothing captured) is a failure, not a pass."""
    content_seen = False
    any_both = any_one = False
    details = []
    for frac in (0.25, 0.5, 0.8):
        t = max(1, round((duration or 12) * frac))
        left = edge_strip(path, t, "crop=6:ih:0:0,scale=1:1:flags=area")
        left_ref = edge_strip(path, t, "crop=6:ih:24:0,scale=1:1:flags=area")
        bottom = edge_strip(path, t, "crop=iw:6:0:ih-6,scale=1:1:flags=area")
        bottom_ref = edge_strip(path, t, "crop=iw:6:0:ih-36,scale=1:1:flags=area")
        # content = the frame's PEAK luminance (signalstats YMAX): real UI
        # frames have bright text pixels somewhere (180+) even on dim screens
        # like the app's unpaired state; a black capture stays under ~25.
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path),
             "-frames:v", "1", "-vf",
             "signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-",
             "-f", "null", "-"], capture_output=True, text=True)
        if None in (left, left_ref, bottom, bottom_ref):
            return "UNREADABLE", "no frame at %ds" % t
        m = re.search(r"YMAX=([\d.]+)", r.stdout or "")
        if m and float(m.group(1)) > 60:
            content_seen = True
        left_bad = abs(left - left_ref) > EDGE_TOLERANCE
        bottom_bad = abs(bottom - bottom_ref) > EDGE_TOLERANCE
        if left_bad and bottom_bad:
            any_both = True
        elif left_bad or bottom_bad:
            any_one = True
        details.append("@%ds L%d/%d B%d/%d" % (t, left, left_ref, bottom, bottom_ref))
    detail = " ".join(details)
    if any_both:
        return "DIRTY", detail
    if not content_seen:
        return "BLACK", detail
    if any_one:
        return "WARN", detail
    return "CLEAN", detail


def check_beats(path):
    side = path.with_suffix(".beats.json")
    if not side.is_file():
        return "NO-SIDECAR", None, "re-record with the current harness"
    data = json.loads(side.read_text(encoding="utf-8"))
    beats = data.get("beats", [])
    short = [b for b in beats
             if b.get("mp3Sec", 0) > 0 and b.get("videoSec", 0) < b["mp3Sec"] - 0.05]
    if short:
        det = "; ".join("%s v%.2f<n%.2f" % (b["beat"], b["videoSec"], b["mp3Sec"])
                        for b in short)
        return "SHORT", data, det
    return "COVERED", data, "%d beats" % len(beats)


def main(episodes):
    failures = 0
    rows = []
    for mpath in sorted(MANIFESTS.glob("*.json")):
        ep = mpath.stem[:2]
        if episodes and ep not in episodes:
            continue
        m = json.loads(mpath.read_text(encoding="utf-8"))
        narration = sum(b.get("duration_s", 0) for b in m["beats"])
        covered_ids = set()
        for src in m["sources"]:
            if not src.get("path"):
                rows.append((ep, src.get("rel") or src.get("note") or "?",
                             "-", "MISSING", "-", "placeholder - footage never recorded"))
                continue
            p = Path(src["path"])
            if not p.is_file():
                rows.append((ep, p.name, "-", "MISSING", "-", "footage not on disk"))
                continue
            dur = ffprobe_duration(p)
            # The edge gate looks for CAPTURE-REGION contamination — window
            # chrome or desktop leaking into a screen recording. Generated or
            # licensed b-roll has no capture region, so the strips it compares
            # are just picture, and a verdict either way would be noise. Its
            # sidecar coverage still matters, so that check stays.
            is_broll = "b-roll" in p.as_posix()
            if is_broll:
                edge_state, edge_detail = "B-ROLL", "not a capture — edge gate n/a"
            else:
                edge_state, edge_detail = check_edges(p, dur)
            beat_state, sidecar, beat_detail = check_beats(p)
            length_ok = True
            if sidecar and sidecar.get("beats"):
                for b in sidecar["beats"]:
                    covered_ids.add(b["beat"])
                last = sidecar["beats"][-1]
                need = last["startSec"] + max(last.get("mp3Sec", 0), 0)
                length_ok = dur is not None and dur + 0.05 >= need
            ok = (edge_state in ("CLEAN", "B-ROLL") and beat_state == "COVERED" and length_ok)
            if not ok:
                failures += 1
            rows.append((ep, p.name, edge_state + " " + edge_detail,
                         beat_state, "%.1fs" % dur if dur else "?",
                         beat_detail + ("" if length_ok else "  !! file shorter than last beat")))
        gaps = [b["id"] for b in m["beats"]
                if b.get("duration_s", 0) > 0 and b["id"] not in covered_ids]
        if gaps:
            rows.append((ep, "(episode)", "-", "GAPS", "%.1fs narr" % narration,
                         "no picture for " + ", ".join(gaps)))

    w = [4, 38, 22, 11, 8]
    hdr = ["ep", "file", "edges", "beats", "video"]
    print("  ".join(h.ljust(x) for h, x in zip(hdr, w)) + "  detail")
    for r in rows:
        print("  ".join(str(c).ljust(x) for c, x in zip(r[:5], w)) + "  " + r[5])
    print("\n%d failure(s)" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(set(sys.argv[1:])))
