# assembly sheets

One sheet per episode: every beat's rendered MP3 length and its cumulative
narration timecode, plus where the footage lives. Regenerate after any
re-voice with `python gen-assembly.py` from this directory (reads the scripts
and rendered audio; makes no API calls).

Each sheet has a machine-readable twin in [`manifests/`](manifests/) that
[`resolve/build_episode.py`](resolve/README.md) turns into a built Resolve
timeline — footage on V1, per-beat narration on A1, a marker per beat carrying
its SCREEN direction.

| ep | title | sheet | narration |
|---|---|---|---|
| 01 | what is owlette? | [01-what-is-owlette.md](01-what-is-owlette.md) | 1:50.4 |
| 02 | day zero: sign up, 2fa, and your first site | [02-day-zero.md](02-day-zero.md) | 3:01.7 |
| 03 | install owlette & pair your first machine | [03-install-and-pair.md](03-install-and-pair.md) | 3:00.3 |
| 04 | the dashboard, end to end | [04-dashboard-tour.md](04-dashboard-tour.md) | 2:15.2 |
| 05 | keep a process alive | [05-keep-a-process-alive.md](05-keep-a-process-alive.md) | 2:15.3 |
| 06 | run apps on a schedule | [06-run-on-a-schedule.md](06-run-on-a-schedule.md) | 2:02.3 |
| 07 | reading machine health | [07-reading-machine-health.md](07-reading-machine-health.md) | 2:21.3 |
| 08 | remote actions: restart, screenshot, live view | [08-remote-actions.md](08-remote-actions.md) | 2:20.6 |
| 09 | the owlette app on the machine | [09-the-owlette-app.md](09-the-owlette-app.md) | 3:12.0 |
| 10 | deploy software to many machines | [10-deploy-software.md](10-deploy-software.md) | 2:41.1 |
| 11 | distribute project folders with roost | [11-distribute-with-roost.md](11-distribute-with-roost.md) | 2:26.4 |
| 12 | hoot: manage machines by chat | [12-cortex.md](12-cortex.md) | 2:51.0 |
| 13 | talons: rules that watch and act | [13-talons.md](13-talons.md) | 3:20.1 |
| 14 | team & alerts | [14-team-and-alerts.md](14-team-and-alerts.md) | 2:46.7 |
| 15 | display layouts: capture a wall, put it back | [15-display-layouts.md](15-display-layouts.md) | 3:09.7 |
| 16 | logs & troubleshooting | [16-logs-and-troubleshooting.md](16-logs-and-troubleshooting.md) | 2:43.2 |
| 17 | keeping the fleet current | [17-fleet-maintenance.md](17-fleet-maintenance.md) | 3:01.9 |
