#!/usr/bin/env python
"""
export_timings.py - read the CURRENT state of the owlette timelines out of
Resolve, so hand edits survive a rebuild.

Run from inside Resolve: Workspace -> Scripts -> owlette export timings.

WHY THIS EXISTS

build_episode.py generates timelines FROM the manifests, and its installed copy
runs with OWLETTE_BUILD_FRESH=1, which deletes an episode's timeline before
rebuilding it. Any timing adjusted by hand in the edit lives only in Resolve's
project database and would be destroyed by the next build with no warning and
no copy.

This walks every "NN-slug vN" timeline and writes, per clip: the track, the
record position, the source in/out, and the duration - in frames and seconds.
Nothing is modified; it is a read.

Output: assembly/resolve/timings-export.json, next to this script's repo copy.
Compare it against the manifests to see which beats were moved, and by how much.
"""

import json
import os
import sys
from datetime import datetime

OUT_PATH = os.environ.get(
    "OWLETTE_TIMINGS_OUT",
    r"C:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\assembly\resolve\timings-export.json",
)
PROJECT_NAME = "owlette tutorials"


def log(msg):
    """Print, tolerating Resolve's stdout.

    Resolve's script host swaps sys.stdout for an `fu_stdout` object that has no
    flush(), so an unguarded flush raises AttributeError and kills the script on
    its first line.
    """
    print(msg)
    try:
        sys.stdout.flush()
    except (AttributeError, ValueError):
        pass


def main():
    # Resolve exposes its API three different ways depending on host and
    # version. Try all of them, and say which one worked - a silent None here
    # is why the first run wrote nothing.
    resolve = None
    how = ""
    if resolve is None:
        try:
            resolve = globals().get("resolve")
            if resolve is not None:
                how = "injected global"
        except Exception:
            resolve = None
    if resolve is None:
        try:
            import DaVinciResolveScript as dvr
            resolve = dvr.scriptapp("Resolve")
            how = "DaVinciResolveScript"
        except Exception as exc:
            log("  (DaVinciResolveScript unavailable: %s)" % exc)
    if resolve is None:
        try:
            mod = os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
                               "Blackmagic Design", "DaVinci Resolve", "Support",
                               "Developer", "Scripting", "Modules")
            if mod not in sys.path:
                sys.path.append(mod)
            import DaVinciResolveScript as dvr2
            resolve = dvr2.scriptapp("Resolve")
            how = "Modules path"
        except Exception as exc:
            log("  (Modules path failed: %s)" % exc)
    if resolve is None:
        log("!! could not reach the Resolve API by any route.")
        log("!! Run this from Workspace -> Scripts (the free edition only")
        log("!! executes scripts from that menu), with a project open.")
        return
    log("connected via: %s" % how)

    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        log("!! no project open")
        return
    if project.GetName() != PROJECT_NAME:
        log('!! the open project is "%s", not "%s" - open the tutorials project first'
            % (project.GetName(), PROJECT_NAME))
        return

    fps = project.GetSetting("timelineFrameRate")
    try:
        fps_f = float(fps)
    except (TypeError, ValueError):
        fps_f = 60.0

    out = {
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "project": project.GetName(),
        "timeline_fps": fps_f,
        "playback_fps": project.GetSetting("timelinePlaybackFrameRate"),
        "timelines": [],
    }

    count = int(project.GetTimelineCount() or 0)
    log("reading %d timeline(s) at %.3f fps" % (count, fps_f))
    for i in range(1, count + 1):
        tl = project.GetTimelineByIndex(i)
        if tl is None:
            continue
        name = tl.GetName() or ""
        start = int(tl.GetStartFrame() or 0)
        rec = {"name": name, "start_frame": start, "tracks": {}}

        for kind in ("video", "audio"):
            n = int(tl.GetTrackCount(kind) or 0)
            for idx in range(1, n + 1):
                items = tl.GetItemListInTrack(kind, idx) or []
                clips = []
                for it in items:
                    try:
                        s, e = int(it.GetStart()), int(it.GetEnd())
                        # GetEnd() is EXCLUSIVE (start + duration) on this
                        # Resolve build, so e - s is the true frame count.
                        # Verified 2026-08-31 against ep01's hand edit: five
                        # consecutive V1 clips export durations that chain
                        # EXACTLY onto the next clip's record frame (865+621 =
                        # 1486, etc), which an inclusive GetEnd() could not
                        # produce. Do not add +1 here.
                        clips.append({
                            "name": it.GetName(),
                            # Record position RELATIVE to the timeline start, so
                            # it can be compared with a manifest's start_frame
                            # (which is an offset, not an absolute timecode).
                            "record_frame": s - start,
                            "record_s": round((s - start) / fps_f, 3),
                            "duration_frames": e - s,
                            "duration_s": round((e - s) / fps_f, 3),
                            "source_in": int(it.GetLeftOffset() or 0),
                        })
                    except Exception as exc:  # a clip type that answers differently
                        clips.append({"name": str(it), "error": str(exc)})
                if clips:
                    rec["tracks"]["%s%d" % ("V" if kind == "video" else "A", idx)] = clips
        out["timelines"].append(rec)
        log("  %-28s %d track(s) with clips" % (name, len(rec["tracks"])))

    try:
        with open(OUT_PATH, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2, ensure_ascii=False)
    except OSError as exc:
        log("!! COULD NOT WRITE %s: %s" % (OUT_PATH, exc))
        return
    log("")
    log("wrote %s  (%d timeline(s))" % (OUT_PATH, len(out["timelines"])))
    log("NOTHING WAS MODIFIED - this is a read.")


main()
