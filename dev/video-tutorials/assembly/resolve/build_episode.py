#!/usr/bin/env python
"""
build_episode.py - pre-build one owlette tutorial episode inside DaVinci Resolve.

Run this from inside Resolve: Workspace -> Scripts -> build_episode.
(The free edition only runs scripts from that menu; see README.md for install.)

What it builds, from `assembly/manifests/NN-slug.json`:
  * a project named "owlette tutorials" (created once, re-used after that)
  * a media-pool bin per episode, holding that episode's footage + beat MP3s
  * a timeline "NN-slug v1" (v2, v3, ... on every re-run - nothing is overwritten)
  * scene footage on V1
  * every beat's narration MP3 on A1 at its cumulative start
  * one marker per beat carrying the beat id, title and its **SCREEN:** direction

The human work starts where it should: zooms, callouts, and pacing.

Verified against the scripting README that ships with DaVinci Resolve 19.0.1
("Last Updated: 16 July 2024"), at
%PROGRAMDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting\\README.txt

UNTESTED IN-APP. See README.md "first run" for the specific calls to watch.
"""

import json
import os
import traceback

# ---------------------------------------------------------------------------
# Config - the two lines an editor may need to touch.
# ---------------------------------------------------------------------------

# Leave "" to be asked which episode to build. Otherwise an episode number
# ("5", "05") or a full stem ("05-keep-a-process-alive").
BUILD_EPISODE = ""

# Where the manifests live. Leave "" to auto-discover (see find_manifest_dir).
MANIFEST_DIR = ""

# Fallback checkout location, used only if nothing else resolves. Edit if your
# clone lives elsewhere.
REPO_DEFAULT = r"C:\Users\admin\Documents\Git\Owlette"

PROJECT_NAME = "owlette tutorials"

# Marker colour per beat kind. These four are the long-standing Resolve marker
# colours; if a name is ever rejected the script reports it and carries on.
COLOR_SCREEN = "Blue"    # beat has an explicit **SCREEN:** direction
COLOR_BROLL = "Cyan"     # only **B-ROLL:** / **ON-SCREEN:** direction
COLOR_SILENT = "Yellow"  # beat with no voiceover
COLOR_MISSING = "Red"    # beat whose MP3 is missing

VIDEO_ONLY = 1  # clipInfo "mediaType"
AUDIO_ONLY = 2


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
class Report(object):
    """Collects everything the run did, so the editor gets one readable block.

    With $OWLETTE_BUILD_LOG set, every line is ALSO appended to that file as it
    happens — the in-app console is invisible to anything outside Resolve, and
    an unattended run (the launcher sets the env) needs a trail that survives
    even a mid-build crash.
    """

    def __init__(self):
        self.lines = []
        self.problems = []
        self.log_path = (os.environ.get("OWLETTE_BUILD_LOG") or "").strip() or None
        if self.log_path:
            try:
                with open(self.log_path, "w", encoding="utf-8") as fh:
                    fh.write("")  # fresh log per run
            except OSError:
                self.log_path = None

    def say(self, text):
        self.lines.append(text)
        if self.log_path:
            try:
                with open(self.log_path, "a", encoding="utf-8") as fh:
                    fh.write(text + "\n")
            except OSError:
                pass
        # Beat titles and SCREEN notes carry em-dashes and curly quotes; a
        # cp1252 console would raise on them mid-build.
        try:
            print(text)
        except UnicodeEncodeError:
            print(text.encode("ascii", "replace").decode("ascii"))

    def warn(self, text):
        self.problems.append(text)
        self.say("  !! " + text)

    def summary(self):
        out = list(self.lines)
        if self.problems:
            out.append("")
            out.append("%d thing(s) need your attention:" % len(self.problems))
            out.extend("  - " + p for p in self.problems)
        else:
            out.append("")
            out.append("no problems.")
        return "\n".join(out)


# ---------------------------------------------------------------------------
# Resolve handles
# ---------------------------------------------------------------------------
def get_resolve():
    """The `resolve` global exists when run from Workspace -> Scripts.

    The import fallback only matters if someone runs this file some other way;
    on the free edition that path is unavailable, which is why the menu is the
    supported route.
    """
    if "resolve" in globals() and globals()["resolve"] is not None:
        return globals()["resolve"]
    try:
        import DaVinciResolveScript as dvr  # type: ignore
        return dvr.scriptapp("Resolve")
    except Exception:
        try:
            bmd_mod = globals().get("bmd")
            if bmd_mod is not None:
                return bmd_mod.scriptapp("Resolve")
        except Exception:
            pass
    return None


# ---------------------------------------------------------------------------
# Manifests
# ---------------------------------------------------------------------------
def find_manifest_dir():
    """First hit wins: env var, the config constant, next to this file, repo."""
    candidates = []
    env = os.environ.get("OWLETTE_MANIFESTS")
    if env:
        candidates.append(env)
    if MANIFEST_DIR:
        candidates.append(MANIFEST_DIR)
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        # resolve/ lives beside manifests/ in the repo; irrelevant once the
        # script has been copied into Resolve's Scripts folder, hence the rest.
        candidates.append(os.path.join(os.path.dirname(here), "manifests"))
    except NameError:
        pass
    candidates.append(
        os.path.join(REPO_DEFAULT, "dev", "video-tutorials", "assembly", "manifests")
    )
    for path in candidates:
        if path and os.path.isdir(path):
            return path
    return None


def load_manifests(folder):
    out = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, name), "r", encoding="utf-8") as fh:
                out.append(json.load(fh))
        except (OSError, ValueError) as exc:
            print("could not read %s: %s" % (name, exc))
    return out


def pick_manifest(manifests, report):
    """BUILD_EPISODE if set, else a dropdown, else give up with a clear message."""
    wanted = (os.environ.get("OWLETTE_BUILD_EPISODE") or BUILD_EPISODE or "").strip()
    if wanted:
        for m in manifests:
            if wanted == m["stem"] or wanted.lstrip("0") == str(m["episode"]):
                return m
        report.warn('BUILD_EPISODE "%s" matched no manifest' % wanted)
        return None
    chosen = prompt_for_episode(manifests, report)
    if chosen is None:
        report.say("no episode chosen - set BUILD_EPISODE at the top of the script "
                   "and run again.")
    return chosen


def prompt_for_episode(manifests, report):
    """A Fusion UIManager dropdown. Returns a manifest, or None if unavailable.

    Guarded end to end: if the UI toolkit is missing or behaves differently on
    this build, the script falls back to the BUILD_EPISODE constant rather than
    dying halfway through.
    """
    try:
        fusion = globals().get("fusion")
        if fusion is None:
            res = get_resolve()
            fusion = res.Fusion() if res else None
        bmd_mod = globals().get("bmd")
        if bmd_mod is None:
            import BlackmagicFusion as bmd_mod  # type: ignore
        if fusion is None or bmd_mod is None:
            return None

        ui = fusion.UIManager
        disp = bmd_mod.UIDispatcher(ui)
        labels = ["%02d  %s" % (m["episode"], m["title"]) for m in manifests]
        state = {"index": 0, "ok": False}

        win = disp.AddWindow(
            {"ID": "OwlBuild", "WindowTitle": "build owlette episode",
             "Geometry": [300, 300, 460, 130]},
            [
                ui.VGroup([
                    ui.Label({"Text": "which episode?", "Weight": 0}),
                    ui.ComboBox({"ID": "Episode", "Weight": 0}),
                    ui.HGroup({"Weight": 0}, [
                        ui.Button({"ID": "Cancel", "Text": "cancel"}),
                        ui.Button({"ID": "Build", "Text": "build"}),
                    ]),
                ]),
            ],
        )
        items = win.GetItems()
        for label in labels:
            items["Episode"].AddItem(label)

        def _close(ev):
            disp.ExitLoop()

        def _build(ev):
            state["index"] = items["Episode"].CurrentIndex
            state["ok"] = True
            disp.ExitLoop()

        win.On.OwlBuild.Close = _close
        win.On.Cancel.Clicked = _close
        win.On.Build.Clicked = _build
        win.Show()
        disp.RunLoop()
        win.Hide()
        return manifests[state["index"]] if state["ok"] else None
    except Exception as exc:
        report.say("  (episode picker unavailable: %s)" % exc)
        return None


# ---------------------------------------------------------------------------
# Project / media pool
# ---------------------------------------------------------------------------
def open_project(pm, report):
    project = pm.LoadProject(PROJECT_NAME)
    if project:
        report.say('opened project "%s"' % PROJECT_NAME)
        return project
    project = pm.CreateProject(PROJECT_NAME)
    if project:
        report.say('created project "%s"' % PROJECT_NAME)
        return project
    current = pm.GetCurrentProject()
    if current:
        report.warn('could not open or create "%s" - building in the open '
                    'project "%s" instead' % (PROJECT_NAME, current.GetName()))
    return current


def apply_format(project, timeline_spec, report):
    """Set frame rate + resolution BEFORE the timeline exists.

    A timeline inherits the project format at creation; changing the project
    rate afterwards does not retro-fit existing timelines.
    """
    fps = timeline_spec.get("fps", 60)
    fps_text = str(int(fps)) if float(fps).is_integer() else str(fps)
    wanted = [
        ("timelineFrameRate", fps_text),
        ("timelineResolutionWidth", str(timeline_spec.get("width", 1920))),
        ("timelineResolutionHeight", str(timeline_spec.get("height", 1080))),
    ]
    for key, value in wanted:
        try:
            ok = project.SetSetting(key, value)
        except Exception as exc:
            ok = False
            report.warn("SetSetting(%s) raised: %s" % (key, exc))
        if not ok:
            current = ""
            try:
                current = project.GetSetting(key)
            except Exception:
                pass
            if str(current) == value:
                continue  # already right; Resolve returns False for a no-op
            report.warn(
                'SetSetting("%s", "%s") returned False (currently "%s") - check '
                "the timeline format by hand" % (key, value, current)
            )
    report.say("format: %sx%s @ %sfps" % (
        timeline_spec.get("width"), timeline_spec.get("height"), fps_text))


def get_or_make_bin(media_pool, name, report):
    root = media_pool.GetRootFolder()
    for folder in root.GetSubFolderList() or []:
        if folder.GetName() == name:
            report.say('re-using bin "%s"' % name)
            media_pool.SetCurrentFolder(folder)
            return folder
    folder = media_pool.AddSubFolder(root, name)
    if not folder:
        report.warn('could not create bin "%s" - importing to the root bin' % name)
        media_pool.SetCurrentFolder(root)
        return root
    report.say('created bin "%s"' % name)
    media_pool.SetCurrentFolder(folder)
    return folder


def existing_by_path(folder):
    """{lowercased file path: MediaPoolItem} for everything already in the bin."""
    found = {}
    for clip in folder.GetClipList() or []:
        try:
            path = clip.GetClipProperty("File Path")
        except Exception:
            continue
        if path:
            found[str(path).lower()] = clip
    return found


def import_media(media_storage, folder, paths, report):
    """Import one path at a time so each returned item maps to a known file."""
    already = existing_by_path(folder)
    items = {}
    for path in paths:
        key = os.path.normpath(path).lower()
        if key in already:
            items[path] = already[key]
            continue
        added = media_storage.AddItemListToMediaPool([path])
        if not added:
            report.warn("Resolve would not import %s" % path)
            continue
        items[path] = added[0]
    return items


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------
def next_timeline_name(project, stem):
    """`stem v1`, then v2, v3 ... so a re-voice never overwrites an edit."""
    taken = set()
    try:
        count = project.GetTimelineCount() or 0
        for i in range(1, int(count) + 1):
            tl = project.GetTimelineByIndex(i)
            if tl:
                taken.add(tl.GetName())
    except Exception:
        pass
    version = 1
    while "%s v%d" % (stem, version) in taken:
        version += 1
    return "%s v%d" % (stem, version)


def clip_fps(item, default_fps):
    """A media pool item's real frame rate, for source-frame math."""
    try:
        val = float(item.GetClipProperty("FPS") or 0)
        return val if val > 0 else default_fps
    except (TypeError, ValueError, Exception):
        return default_fps

def sidecar_for(path):
    """`<footage>.beats.json` written by the record harness, if present."""
    side = os.path.splitext(path)[0] + ".beats.json"
    return side if os.path.isfile(side) else None

def build_conform_index(manifest, report):
    """beat id -> {path, in_s}: where each beat's picture lives in its footage.

    Scene footage claims its beats first; inserts/alt takes fill only the
    remaining beats (ep03's pairing clip covers its beat while the wizard
    beats stay empty). The harness enforces videoSec >= mp3Sec per beat at
    record time, so trimming a segment to its narration length is always safe.
    An empty index means the footage predates beat enforcement.
    """
    index = {}
    ordered = ([s for s in manifest["sources"] if s.get("role") == "scene" and s.get("exists")]
               + [s for s in manifest["sources"] if s.get("role") != "scene" and s.get("exists")])
    for src in ordered:
        side = sidecar_for(src["path"])
        if side is None:
            continue
        try:
            with open(side) as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            report.warn("unreadable sidecar %s: %s" % (os.path.basename(side), exc))
            continue
        for mark in data.get("beats", []):
            bid = mark.get("beat")
            if not bid or bid in index:
                continue
            index[bid] = {"path": src["path"], "in_s": float(mark.get("startSec", 0)),
                          "mp3_s": float(mark.get("mp3Sec", 0)),
                          "video_s": float(mark.get("videoSec", 0))}
    return index

def append_clip(media_pool, item, record_frame, media_type, track_index, report, label,
                src_in=None, src_out=None):
    """AppendToTimeline for one clip, with a minimal-dict retry.

    The README documents clipInfo as "mediaPoolItem", "startFrame", "endFrame",
    plus optional "mediaType", "trackIndex" and "recordFrame". Builds differ in
    how strict they are about the source range, so try the explicit form first
    and fall back to letting Resolve use the whole clip.

    src_in/src_out (source frames, inclusive) request an exact segment - a
    conform cut. There is deliberately NO whole-clip fallback for those: a
    full-length append at that record frame would bury the neighbouring beats'
    segments, which is worse than the gap a skip leaves.
    """
    frames = 0
    try:
        frames = int(float(item.GetClipProperty("Frames") or 0))
    except (TypeError, ValueError, Exception):
        frames = 0

    attempts = []
    base = {"mediaPoolItem": item, "mediaType": media_type,
            "trackIndex": track_index, "recordFrame": int(record_frame)}
    if src_in is not None:
        exact = dict(base)
        exact["startFrame"] = int(src_in)
        exact["endFrame"] = int(src_out)
        attempts.append(exact)
    elif frames > 0:
        explicit = dict(base)
        explicit["startFrame"] = 0
        explicit["endFrame"] = frames - 1
        attempts.append(explicit)
        attempts.append(base)
    else:
        attempts.append(base)

    for clip_info in attempts:
        try:
            added = media_pool.AppendToTimeline([clip_info])
        except Exception as exc:
            report.warn("append raised for %s: %s" % (label, exc))
            return None
        if added:
            return added[0]
    report.warn("could not place %s at frame %d" % (label, record_frame))
    return None


def marker_color(beat):
    if beat.get("status") == "MISSING":
        return COLOR_MISSING
    if not beat.get("spoken"):
        return COLOR_SILENT
    return COLOR_SCREEN if "SCREEN" in (beat.get("direction") or {}) else COLOR_BROLL


def marker_note(beat):
    direction = beat.get("direction") or {}
    parts = []
    for label in ("SCREEN", "B-ROLL", "ON-SCREEN", "NOTE"):
        if direction.get(label):
            parts.append("%s: %s" % (label, direction[label]))
    if beat.get("status") == "MISSING":
        parts.append("!! narration MP3 missing: %s" % beat.get("mp3_name", "?"))
    return "\n\n".join(parts) or beat.get("screen_note", "")


def build(manifest, report):
    res = get_resolve()
    if res is None:
        report.warn("no `resolve` object - run this from Workspace -> Scripts "
                    "inside DaVinci Resolve.")
        return
    pm = res.GetProjectManager()
    project = open_project(pm, report)
    if project is None:
        report.warn("no project to build into - stopping.")
        return

    spec = manifest.get("timeline") or {}
    fps = float(spec.get("fps", 60))
    apply_format(project, spec, report)

    media_pool = project.GetMediaPool()
    bin_folder = get_or_make_bin(media_pool, manifest["stem"], report)

    # --- gather the files -------------------------------------------------
    scenes = [s for s in manifest["sources"] if s.get("role") == "scene" and s.get("exists")]
    extras = [s for s in manifest["sources"] if s.get("role") != "scene" and s.get("exists")]
    for src in manifest["sources"]:
        if not src.get("exists"):
            report.warn("footage not on disk: %s" % (src.get("rel") or src.get("note")))

    beats = manifest["beats"]
    audio_paths = []
    for beat in beats:
        if beat.get("mp3"):
            if os.path.isfile(beat["mp3"]):
                audio_paths.append(beat["mp3"])
            else:
                # The manifest saw this file; it has since moved or been deleted.
                report.warn("%s: narration gone since the manifest was generated "
                            "(%s) - re-run gen-assembly.py"
                            % (beat["id"], beat["mp3"]))
        elif beat.get("status") == "MISSING":
            report.warn("%s: no narration rendered (%s)"
                        % (beat["id"], beat.get("mp3_name")))

    to_import = [s["path"] for s in scenes] + [s["path"] for s in extras] + audio_paths
    for path in [p for p in to_import if not os.path.isfile(p)]:
        report.warn("file vanished since the manifest was generated: %s" % path)
    to_import = [p for p in to_import if os.path.isfile(p)]

    media_storage = res.GetMediaStorage()
    items = import_media(media_storage, bin_folder, to_import, report)
    report.say("imported %d of %d file(s)" % (len(items), len(to_import)))

    # --- timeline ---------------------------------------------------------
    name = next_timeline_name(project, manifest["stem"])
    timeline = media_pool.CreateEmptyTimeline(name)
    if not timeline:
        report.warn('could not create timeline "%s" - stopping.' % name)
        return
    project.SetCurrentTimeline(timeline)
    report.say('timeline "%s"' % name)

    if (timeline.GetTrackCount("audio") or 0) < 1:
        timeline.AddTrack("audio", "stereo")

    # Marker frameIds are timeline OFFSETS (0 = first frame), but a clip's
    # recordFrame is an ABSOLUTE timeline frame - and a Resolve timeline starts
    # at 01:00:00:00, not zero. Getting these two confused is the classic way to
    # land every clip an hour away from every marker.
    try:
        start = int(timeline.GetStartFrame() or 0)
    except Exception:
        start = 0
    report.say("timeline starts at frame %d" % start)

    # --- V1: scene footage ------------------------------------------------
    # Conform mode: every beat's picture is cut from its footage at the
    # sidecar's timecode, trimmed to the narration length, and placed at the
    # narration's own frame - picture and audio line up beat by beat. The
    # butt-joint fallback exists only for pre-sidecar footage and does NOT
    # produce a synced edit.
    conform = build_conform_index(manifest, report)
    if conform:
        placed_video = 0
        gap_beats = []
        end_frame = 0
        for i, beat in enumerate(beats):
            cut = conform.get(beat["id"])
            dur_s = float(beat.get("duration_s") or 0)
            item = items.get(cut["path"]) if cut else None
            if item is None or dur_s <= 0:
                gap_beats.append(beat["id"])
                continue
            if cut["mp3_s"] and abs(cut["mp3_s"] - dur_s) > 0.05:
                report.warn("%s: sidecar narration %.2fs != manifest %.2fs - the "
                            "footage predates a re-voice; re-record it before "
                            "trusting this cut" % (beat["id"], cut["mp3_s"], dur_s))
            # Segment length comes from the manifest's own frame grid. The
            # start_frames are round(cumulative seconds); deriving length as a
            # SECOND independent rounding of duration_s made the two grids
            # disagree by one frame (round(sum) != sum(round)) - one-frame
            # collisions with the next beat's recordFrame, one-frame holes
            # between others. The last beat has no successor, so its own
            # rounded duration is the grid.
            if i + 1 < len(beats):
                length = int(beats[i + 1]["start_frame"]) - int(beat["start_frame"])
            else:
                length = int(round(dur_s * fps))
            src_fps = clip_fps(item, fps)
            src_in = int(round(cut["in_s"] * src_fps))
            src_len = max(1, int(round(length * src_fps / fps)))
            # Never cut past the picture that actually exists for this beat:
            # the sidecar's videoSec is this beat's measured segment length,
            # and src_in is that segment's first frame.
            if cut["video_s"]:
                avail = max(1, int(round(cut["video_s"] * src_fps)))
                if src_len > avail:
                    report.warn("%s: needs %d source frames but its segment only "
                                "has %d - trimming (re-record if this repeats)"
                                % (beat["id"], src_len, avail))
                    src_len = avail
            src_out = src_in + src_len - 1
            placed = append_clip(media_pool, item, start + int(beat["start_frame"]),
                                 VIDEO_ONLY, 1, report,
                                 "%s <- %s" % (beat["id"], os.path.basename(cut["path"])),
                                 src_in=src_in, src_out=src_out)
            if placed is not None:
                placed_video += 1
                end_frame = int(beat["start_frame"]) + src_len
        report.say("V1 conform: %d/%d beat segment(s) placed, ends at frame %d"
                   % (placed_video, len(beats), end_frame))
        if gap_beats:
            report.warn("no picture for %s - left as V1 gap(s)" % ", ".join(gap_beats))
    else:
        report.warn("NO beat sidecars next to this episode's footage - butt-joint "
                    "fallback; audio will NOT line up. Re-record with the current "
                    "harness (it writes <scene>.beats.json) and rebuild.")
        cursor = 0
        for src in scenes:
            item = items.get(src["path"])
            if item is None:
                continue
            placed = append_clip(media_pool, item, start + cursor, VIDEO_ONLY, 1,
                                 report, os.path.basename(src["path"]))
            if placed is None:
                continue
            try:
                cursor = int(placed.GetEnd()) - start
            except Exception:
                cursor += int(round(float(src.get("duration_s") or 0) * fps))
        report.say("V1: %d scene clip(s), %d frames" % (len(scenes), cursor))
    if extras:
        if conform:
            used = set(c["path"] for c in conform.values())
            report.say("%d insert/alt clip(s) imported; %d feed the conform"
                       % (len(extras), sum(1 for s in extras if s["path"] in used)))
            for s in extras:
                if s["path"] in used:
                    continue
                if sidecar_for(s["path"]) is None:
                    report.warn("insert %s has no sidecar - not placed"
                                % os.path.basename(s["path"]))
                else:
                    report.warn("insert %s: every beat in its sidecar is already "
                                "claimed by a scene take - not placed"
                                % os.path.basename(s["path"]))
        else:
            report.say("%d insert/alt clip(s) imported to the bin, not placed"
                       % len(extras))

    # --- A1: one MP3 per beat at its cumulative start ---------------------
    placed_audio = 0
    drifted = 0
    for beat in beats:
        path = beat.get("mp3")
        if not path or path not in items:
            continue
        want = start + int(beat["start_frame"])
        placed = append_clip(media_pool, items[path], want, AUDIO_ONLY, 1,
                             report, "%s %s" % (beat["id"], beat.get("mp3_name", "")))
        if placed is None:
            continue
        placed_audio += 1
        try:
            got = int(placed.GetStart())
        except Exception:
            continue
        if abs(got - want) > 1:
            drifted += 1
            report.warn("%s landed at frame %d, wanted %d (%+d)"
                        % (beat["id"], got, want, got - want))
    report.say("A1: %d narration clip(s) placed" % placed_audio)
    if drifted:
        report.warn("%d clip(s) did not honour recordFrame - see README "
                    '"audio placement"' % drifted)

    # --- markers ----------------------------------------------------------
    used = set()
    made = 0
    for beat in beats:
        frame = int(beat["start_frame"])
        while frame in used:
            frame += 1  # two markers cannot share a frame
        used.add(frame)
        title = "%s %s" % (beat["id"], beat.get("title", ""))
        try:
            ok = timeline.AddMarker(frame, marker_color(beat), title.strip(),
                                    marker_note(beat), 1, beat["id"])
        except Exception as exc:
            ok = False
            report.warn("AddMarker raised for %s: %s" % (beat["id"], exc))
        if ok:
            made += 1
        else:
            report.warn("marker for %s (frame %d) was rejected" % (beat["id"], frame))
    report.say("markers: %d of %d beat(s)" % (made, len(beats)))

    try:
        pm.SaveProject()
    except Exception:
        pass


def show(report):
    """Best-effort dialog so the summary is visible without the Console open.

    Every line was printed live as it happened, so the console only gets the
    tail; the dialog gets the whole thing.
    """
    text = report.summary()
    if report.problems:
        report.say("")
        report.say("%d thing(s) need your attention (see above)." % len(report.problems))
    else:
        report.say("")
        report.say("done - no problems.")
    try:
        fusion = globals().get("fusion")
        if fusion is None:
            res = get_resolve()
            fusion = res.Fusion() if res else None
        if fusion is not None:
            fusion.AskUser("build_episode", [
                {1: "summary", 2: "Text", "Lines": 24, "Default": text, "ReadOnly": True},
            ])
    except Exception:
        pass


def main():
    report = Report()
    folder = find_manifest_dir()
    if not folder:
        report.warn("no manifests folder found. Set MANIFEST_DIR at the top of "
                    "this script, or $OWLETTE_MANIFESTS, then run again.")
        show(report)
        return
    report.say("manifests: %s" % folder)

    manifests = load_manifests(folder)
    if not manifests:
        report.warn("no manifests in %s - run gen-assembly.py first." % folder)
        show(report)
        return

    # "ALL" (env or the constant) builds every episode in one run — the mode an
    # unattended launcher uses, so it must never open a dialog mid-run.
    wanted = (os.environ.get("OWLETTE_BUILD_EPISODE") or BUILD_EPISODE or "").strip()
    if wanted.upper() == "ALL":
        chosen = list(manifests)
    else:
        manifest = pick_manifest(manifests, report)
        if manifest is None:
            show(report)
            return
        chosen = [manifest]

    built = 0
    for manifest in chosen:
        report.say("")
        report.say("=== building episode %02d - %s ===" % (manifest["episode"], manifest["title"]))
        try:
            build(manifest, report)
            built += 1
        except Exception:
            # One broken episode must not sink the other sixteen.
            report.warn("episode %02d stopped on an unexpected error:\n%s"
                        % (manifest["episode"], traceback.format_exc()))
    report.say("")
    report.say("built %d of %d episode timeline(s)" % (built, len(chosen)))

    # Unattended runs read the log file; a modal dialog would just hold the app
    # hostage with nobody at the desk.
    if report.log_path:
        report.say("summary written to %s" % report.log_path)
    else:
        show(report)


if __name__ == "__main__":
    main()
