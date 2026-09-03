"""Queue and render every episode's NEWEST timeline to a delivery folder.

Run from DaVinci Resolve: Workspace -> Scripts -> "owlette render all".
(Resolve free only executes scripts from inside the app, so this cannot be
driven externally - the click is the operator's.)

For each manifest in the assembly, the script finds the highest "{stem} vN"
timeline (the naming build_episode.py uses), queues an H.264 MP4 render of the
whole timeline into OWLETTE_RENDER_DIR, starts the queue, waits, and writes a
per-job status log the orchestrator can read:

  OWLETTE_RENDER_DIR  target folder (default: the TEC Dropbox delivery path)
  OWLETTE_RENDER_LOG  log file (default: render-log.txt beside this script)

A stem with no timeline is logged and skipped - build first ("owlette rebuild
revoiced" for the card layout), then render. Only jobs this run queued are
started or reported; an existing render queue is left alone.
"""

import glob
import json
import os
import re
import time
import traceback

DEFAULT_DIR = r"C:\Users\admin\TEC Dropbox\Dylan Roscover\x\owlette-video-tutorials"
REPO_MANIFESTS = (
    r"c:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\assembly\manifests"
)
TARGET_DIR = os.environ.get("OWLETTE_RENDER_DIR", DEFAULT_DIR)
LOG_PATH = os.environ.get(
    "OWLETTE_RENDER_LOG",
    r"c:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\assembly\resolve\render-log.txt",
)
# 1080p60 screen tutorials with dark gradients: 30 Mb/s keeps the dither
# (and therefore the de-banding) that the capture chain paid for.
VIDEO_BITRATE = 30_000_000

LINES = []


def say(text):
    LINES.append(text)
    print(text)


def flush_log():
    try:
        with open(LOG_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(LINES) + "\n")
    except OSError as exc:
        print("could not write log: %s" % exc)


def get_resolve():
    r = globals().get("resolve")
    if r is not None:
        return r
    try:
        import DaVinciResolveScript as dvr  # type: ignore

        return dvr.scriptapp("Resolve")
    except Exception:
        return None


def newest_timelines(project, stems):
    """{stem: timeline} - the highest 'stem vN' per stem, if any exists."""
    best = {}  # stem -> (version, timeline)
    count = int(project.GetTimelineCount() or 0)
    for i in range(1, count + 1):
        tl = project.GetTimelineByIndex(i)
        if not tl:
            continue
        name = tl.GetName() or ""
        m = re.match(r"^(.+) v(\d+)$", name)
        if not m or m.group(1) not in stems:
            continue
        stem, version = m.group(1), int(m.group(2))
        if stem not in best or version > best[stem][0]:
            best[stem] = (version, tl)
    return {stem: tl for stem, (_v, tl) in best.items()}


def main():
    res = get_resolve()
    if res is None:
        say("no `resolve` object - run from Workspace -> Scripts inside Resolve.")
        return 1
    project = res.GetProjectManager().GetCurrentProject()
    if project is None:
        say("no open project.")
        return 1

    if not os.path.isdir(TARGET_DIR):
        try:
            os.makedirs(TARGET_DIR)
        except OSError as exc:
            say("cannot create target dir %s (%s)" % (TARGET_DIR, exc))
            return 1

    stems = []
    for path in sorted(glob.glob(os.path.join(REPO_MANIFESTS, "*.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                stems.append(json.load(fh)["stem"])
        except (OSError, ValueError, KeyError) as exc:
            say("unreadable manifest %s (%s)" % (os.path.basename(path), exc))

    timelines = newest_timelines(project, set(stems))
    missing = [s for s in stems if s not in timelines]
    for s in missing:
        say("SKIP %-30s no timeline built" % s)

    jobs = []  # (stem, timeline_name, job_id)
    for stem in stems:
        tl = timelines.get(stem)
        if tl is None:
            continue
        if not project.SetCurrentTimeline(tl):
            say("FAIL %-30s could not select timeline" % stem)
            continue
        ok = project.SetCurrentRenderFormatAndCodec("mp4", "H264")
        if not ok:
            say("FAIL %-30s mp4/H264 not accepted" % stem)
            continue
        try:
            project.SetCurrentRenderMode(1)  # 1 = single clip
        except Exception:
            pass
        settings = {
            "SelectAllFrames": True,
            "TargetDir": TARGET_DIR,
            "CustomName": stem,
            "UniqueFilenameStyle": 0,
            "ExportVideo": True,
            "ExportAudio": True,
            "FormatWidth": 1920,
            "FormatHeight": 1080,
            "VideoQuality": VIDEO_BITRATE,
            "AudioSampleRate": 48000,
        }
        if not project.SetRenderSettings(settings):
            say("FAIL %-30s render settings rejected" % stem)
            continue
        job_id = project.AddRenderJob()
        if not job_id:
            say("FAIL %-30s AddRenderJob returned nothing" % stem)
            continue
        jobs.append((stem, tl.GetName(), job_id))
        say("queued %-28s <- %s" % (stem, tl.GetName()))

    if not jobs:
        say("nothing queued - build timelines first.")
        flush_log()
        return 1

    say("rendering %d job(s) to %s ..." % (len(jobs), TARGET_DIR))
    flush_log()
    ids = [j[2] for j in jobs]
    try:
        started = project.StartRendering(ids, False)
    except TypeError:
        # Older API builds take job ids as varargs, no bool.
        started = project.StartRendering(*ids)
    if not started:
        say("StartRendering refused - is the render queue already running?")
        flush_log()
        return 1
    while project.IsRenderingInProgress():
        time.sleep(5)

    failures = 0
    for stem, tl_name, job_id in jobs:
        try:
            status = project.GetRenderJobStatus(job_id) or {}
        except Exception as exc:
            status = {"JobStatus": "unknown (%s)" % exc}
        state = status.get("JobStatus", "?")
        pct = status.get("CompletionPercentage")
        out = os.path.join(TARGET_DIR, "%s.mp4" % stem)
        on_disk = os.path.isfile(out)
        if state == "Complete" and on_disk:
            say("DONE %-30s %s" % (stem, out))
        else:
            failures += 1
            say("FAIL %-30s status=%s pct=%s on_disk=%s (from %s)"
                % (stem, state, pct, on_disk, tl_name))
    say("%d of %d rendered%s" % (len(jobs) - failures, len(jobs),
                                 "" if not failures else " - %d FAILED" % failures))
    flush_log()
    return 1 if failures or missing else 0


# No sys.exit: a SystemExit inside Resolve's embedded console reads as a
# script error. The log file carries the outcome.
try:
    main()
except Exception:
    say("render_all crashed:\n" + traceback.format_exc())
    flush_log()
