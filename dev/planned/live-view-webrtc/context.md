# live-view-webrtc — context

**Created**: 2026-04-26
**Status**: Stub (deferred — resume when prioritized)
**Spun out of**: `dev/completed/api-sprint/` Wave 4 (originally an SSE-based spike).

## problem statement

`owlette machine live-view <machineId>` is the only tier-C stub remaining in the
owlette CLI after api-sprint W5.1 closed. The original api-sprint plan parked it
behind a 2-day SSE spike (`agent → server → client` server-sent events) but the
sprint shipped without it, leaving the cli command exiting with code 3 and a
"future plan" pointer.

This plan reframes the feature around **WebRTC** instead of an SSE bridge,
because:

- **SSE is one-way and text-only.** Streaming a desktop frame-by-frame would
  require base64-encoding image bytes and pumping them through a long-lived
  http connection — high latency, high egress cost, and no path to audio or
  bidirectional control.
- **WebRTC is purpose-built for low-latency media.** Browsers and node clients
  speak it natively (or via well-maintained libraries). Frame encoding,
  bandwidth adaptation, and NAT traversal are solved problems.
- **Dashboard integration is more natural.** A `<video>` element receiving a
  WebRTC track Just Works in the browser with no custom canvas/render loop.
  An `owlette machine live-view` cli invocation would either spin up a local
  preview window (electron, ffplay) or stream to stdout for piping into ffmpeg.

## what this plan will own (when resumed)

1. **Spike memo** — measure latency / bandwidth / signaling complexity for a
   WebRTC live-view stream from a Windows kiosk to (a) the dashboard and (b)
   a CLI consumer. Compare against the SSE alternative for completeness.
2. **Signaling channel** — likely Firestore-mediated SDP/ICE exchange (matches
   the existing agent ↔ server channel; no new infra). Decide whether a TURN
   server is required for symmetric NAT traversal in customer environments.
3. **Agent capture** — Windows desktop capture pipeline. Likely OBS-style
   approach (Desktop Duplication API → H.264/VP9 encode → WebRTC track).
   Re-use anything possible from the existing `screenshot_capture.py`
   pipeline (`mss`-based capture).
4. **Dashboard player** — `<video>` element + WebRTC connection + a couple of
   overlay controls (request key frame, FPS readout, network stats).
5. **CLI consumer** — `owlette machine live-view <machineId> [--output rtp://...]`.
   Defaults to opening a local preview window (or instructions to pipe through
   ffplay) — TBD per spike findings.
6. **Privacy + consent** — live-streaming a customer's kiosk screen is a
   different consent surface than reading a process list. Needs a per-site
   policy toggle, an audit-log entry per session, and probably a visual
   indicator on the kiosk during streaming.
7. **Bandwidth / cost model** — model what a 50-kiosk fleet streaming
   simultaneously would cost in egress + TURN-relay if needed. Set per-site
   quotas in `sites/{siteId}.liveViewQuota`.

## why deferred

- Not user-facing critical — every other api-sprint deliverable shipped
  without it.
- WebRTC infrastructure (signaling, TURN, encoding) is meaningful new
  surface area that warrants its own focused sprint, not a 2-day spike
  bolted onto the api-sprint close.
- No customer has asked for it yet; current screenshot-on-demand covers
  the "what's on the screen right now?" question for diagnostic use.

## non-goals (for the eventual sprint)

- **Full RDP-style remote control** (mouse + keyboard injection). Live-view
  is read-only by design. Remote control is a separate plan with much
  larger consent / security implications.
- **Persistent recording.** Streams are ephemeral; recording is a future
  feature if customer demand surfaces.
- **Audio.** Could be added once video stabilizes; not in scope for the
  initial implementation.

## what to do today

Nothing. The cli command [cli/src/commands/machine.ts:432](../../../cli/src/commands/machine.ts#L432)
is a clean tier-C stub that exits 3 with a pointer to this plan. When the
feature resumes, fill in `plan.md` + `tasks.md` and start executing.
