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
        src_fps = fps                     # all footage is 60fps (verified)
        segs, seg_warns = be.beat_segments(beats, i, cut, fps, src_fps)
        for w in seg_warns:
            if w.startswith("needs "):    # the videoSec trim, kept as before
                print("  %s %s: TRIM %s" % (m["stem"], beat["id"], w))
            else:
                print("  %s %s: %s" % (m["stem"], beat["id"], w))
            problems += 1
        start = int(beat["start_frame"])
        lo = min(a for a, _l, _si, _sl, _f in segs) if segs else 0
        hi = max(a + l for a, l, _si, _sl, _f in segs) if segs else 0
        placed.append((beat["id"], start + lo, start + hi))

    # 1 + 2: adjacency of consecutive PLACED segments
    beat_by_id = {b["id"]: b for b in beats}
    for (aid, a0, a1), (bid, b0, b1) in zip(placed, placed[1:]):
        if a1 > b0:
            print("  %s: COLLISION %s ends %d > %s starts %d" % (m["stem"], aid, a1, bid, b0))
            problems += 1
        elif a1 < b0:
            # a hole is expected when a gap beat sits between them, or when
            # the gap is exactly the next beat's title card (the card clip
            # fills it — see build_episode.card_slots).
            ids = [b["id"] for b in beats]
            between = ids[ids.index(aid) + 1:ids.index(bid)]
            card_frames = int((beat_by_id[bid].get("card") or {}).get("frames") or 0)
            if not between and (b0 - a1) != card_frames:
                print("  %s: HOLE of %d frame(s) between %s and %s"
                      % (m["stem"], b0 - a1, aid, bid))
                problems += 1
    stale = [w for w in r.warns]
    print("%-28s %2d placed, gaps=%s%s" % (
        m["stem"], len(placed), ",".join(gaps) or "none",
        ("  warns=%d" % len(stale)) if stale else ""))

print("\n%d conform problem(s)" % problems)
sys.exit(1 if problems else 0)
