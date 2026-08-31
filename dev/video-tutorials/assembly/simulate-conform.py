"""Dry-run the V1 conform against the REAL manifests + sidecars.

Imports build_episode's own index builder so the simulation cannot drift from
the code Resolve will run, then reproduces the placement arithmetic and checks
the three properties the builder promises:
  1. no two placed segments overlap (a collision can drop a whole beat)
  2. no unintended hole between consecutive placed beats (black flash frames)
  3. every cut lies inside the picture the sidecar says exists
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, r"c:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\assembly\resolve")
import build_episode as be

MANIFESTS = Path(r"c:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\assembly\manifests")

class R:
    def __init__(self):
        self.warns = []
    def warn(self, t):
        self.warns.append(t)
    def say(self, t):
        pass

problems = 0
for mpath in sorted(MANIFESTS.glob("*.json")):
    m = json.loads(mpath.read_text(encoding="utf-8"))
    fps = float((m.get("timeline") or {}).get("fps", 60))
    r = R()
    conform = be.build_conform_index(m, r)
    if not conform:
        print("%s: NO SIDECARS (fallback path)" % m["stem"])
        continue
    beats = m["beats"]
    placed = []          # (beat_id, start, end_exclusive)
    gaps = []
    for i, beat in enumerate(beats):
        cut = conform.get(beat["id"])
        dur_s = float(beat.get("duration_s") or 0)
        if cut is None or dur_s <= 0:
            gaps.append(beat["id"])
            continue
        if i + 1 < len(beats):
            length = int(beats[i + 1]["start_frame"]) - int(beat["start_frame"])
        else:
            length = int(round(dur_s * fps))
        src_fps = fps                     # all footage is 60fps (verified)
        src_in = int(round(cut["in_s"] * src_fps))
        src_len = max(1, int(round(length * src_fps / fps)))
        avail = max(1, int(round(cut["video_s"] * src_fps))) if cut["video_s"] else None
        if avail is not None and src_len > avail:
            print("  %s %s: TRIM needed %d > avail %d" % (m["stem"], beat["id"], src_len, avail))
            problems += 1
            src_len = avail
        start = int(beat["start_frame"])
        placed.append((beat["id"], start, start + src_len))

    # 1 + 2: adjacency of consecutive PLACED segments
    for (aid, a0, a1), (bid, b0, b1) in zip(placed, placed[1:]):
        if a1 > b0:
            print("  %s: COLLISION %s ends %d > %s starts %d" % (m["stem"], aid, a1, bid, b0))
            problems += 1
        elif a1 < b0:
            # a hole is only expected when a gap beat sits between them
            ids = [b["id"] for b in beats]
            between = ids[ids.index(aid) + 1:ids.index(bid)]
            if not between:
                print("  %s: HOLE of %d frame(s) between %s and %s"
                      % (m["stem"], b0 - a1, aid, bid))
                problems += 1
    stale = [w for w in r.warns]
    print("%-28s %2d placed, gaps=%s%s" % (
        m["stem"], len(placed), ",".join(gaps) or "none",
        ("  warns=%d" % len(stale)) if stale else ""))

print("\n%d conform problem(s)" % problems)
sys.exit(1 if problems else 0)
