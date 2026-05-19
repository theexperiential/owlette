# live-view-webrtc — plan

**Created**: 2026-04-26
**Status**: Stub — execution deferred until prioritized.

Read [context.md](context.md) for the framing. This file holds the wave-by-wave
plan that gets fleshed out when the feature resumes.

## scope

WebRTC-native live-view streaming from a Windows kiosk to (a) the dashboard
and (b) a CLI consumer. Reframed from the api-sprint Wave 4 SSE spike (which
shipped never).

## planned waves (placeholder)

```
wave 0   spike + design memo
  ├─ 0.1  prototype WebRTC capture loop on Windows (Desktop Duplication API → H.264 → WebRTC track)
  ├─ 0.2  signaling design — Firestore-mediated SDP/ICE exchange (mirrors the agent ↔ server channel)
  ├─ 0.3  TURN-server requirement assessment (NAT topology survey for customer environments)
  ├─ 0.4  bandwidth + cost model — 50-kiosk fleet streaming simultaneously
  └─ 0.5  privacy + consent design — per-site policy toggle, audit emission, on-screen indicator

wave 1   server-side signaling
  ├─ POST /api/sites/{s}/machines/{m}/live-view/sessions  (start session, mint signaling channel)
  ├─ GET  /api/sites/{s}/machines/{m}/live-view/sessions/{id}  (session status)
  └─ DELETE /api/sites/{s}/machines/{m}/live-view/sessions/{id}  (tear down)

wave 2   agent-side capture pipeline
  ├─ agent/src/live_view_capture.py — Desktop Duplication API → encoder
  └─ agent/src/live_view_session.py — WebRTC peer + ICE handling

wave 3   dashboard player
  └─ web/app/(dashboard)/machines/[machineId]/live-view/page.tsx + <video> element + controls

wave 4   CLI consumer
  └─ cli/src/commands/machine.ts — flip live-view from stubExit() to real handler

wave 5   sprint close
  ├─ e2e (Playwright) coverage
  ├─ load-test (concurrent stream count)
  ├─ docs page
  └─ changelog entry + whatever version bump fits
```

These waves are intentionally vague — the spike (Wave 0) shapes everything
downstream. The shape will firm up once we have latency / bandwidth / TURN
numbers in hand.

## key decisions to lock during the spike

1. **Encoder choice** — H.264 (broad compat) vs VP9 (better quality at low
   bitrate, narrower compat). Per-platform availability matters; Windows
   ships H.264 via Media Foundation natively.
2. **Signaling transport** — Firestore mediated (low ops cost, reuses the
   existing agent ↔ server channel) vs WebSocket gateway (lower latency
   but new infra). Default: Firestore.
3. **TURN server** — required if customer kiosks sit behind symmetric NATs.
   Likely needed; coturn self-hosted or Twilio/Cloudflare managed are the
   options. Cost model from the spike informs choice.
4. **CLI consumer ergonomics** — open local preview window (electron, mpv,
   ffplay) vs stream to stdout for piping. Probably both, with `--output -`
   = stdout and default = launch preview.
5. **Privacy/consent surface** — per-site `liveViewPolicy: 'always-allow' |
   'require-confirmation' | 'disabled'`. Probably default `disabled` and
   require explicit per-site opt-in.

## relationship to other plans

- **api-sprint** (`dev/completed/api-sprint/`) — closed without live-view.
  The cli `owlette machine live-view` stub points here.
- **roost-public-api** (`dev/active/roost-public-api/`) — independent. Live-view
  is not on the public-launch critical path.
- **owlette-cli** (`dev/active/owlette-cli/`) — wave 3 stub for live-view stays
  in place. Promotion is wave 4 of THIS plan.

## resume checklist

When this feature is prioritized again:

1. Schedule the spike (wave 0) — 3-5 days for one engineer, including the
   memo write-up.
2. Pull in or write `tasks.md` with concrete sub-tasks per wave.
3. Decide on a target ship date for the spike memo before starting wave 1.
