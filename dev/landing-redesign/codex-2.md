1. **Audience read.**

the highest-converting visitor in 2026 is still the operator responsible for unattended windows machines in public: signage networks, museums, theme parks, control rooms, churches, events, retail flagships, and xr stages. they buy because a blank screen is visible, embarrassing, and expensive. second is the av/show-control specialist who owns display geometry, projector walls, led processors, and "please do not break the video wall before doors" risk. this audience may be smaller, but the display-topology story is the page's sharpest differentiator. third is the developer or platform engineer who wants fleet control inside ci, internal tools, or incident response. they will not convert from vibes, but they will convert if the page proves scoped keys, openapi, idempotency, webhooks, cli, and sdk are real. i would not make developers the hero audience. the current page already leads with physical-machine use cases through rotating words like "digital signage", "touchdesigner pcs", and "unreal engine nodes" (`web/components/landing/HeroSection.tsx:10`), while the api is only implied in the "control" card (`web/components/landing/UseCaseSection.tsx:17`). the redesign should keep the operator heart and pull developers and display specialists into the proof path much earlier.

2. **The wedge.**

owlette wins because it is a windows fleet control plane for computers people can actually see: it keeps processes alive, lets operators take action remotely, lets developers script the same actions through a real api, and adds safe display-layout management that generic rmm tools, signage cms products, and hand-rolled scripts do not combine. the key is not "monitoring" alone. the key is "i can restart the media server, deploy the fix, ask what happened, or change the projector wall layout from one place, with rollback and audit trails." current landing code undersells that breadth: `web/app/page.tsx:52` through `web/app/page.tsx:57` renders hero, dashboard, four old use cases, verticals, pricing, faq, and footer, while the live product has a scalar api reference (`web/app/docs/api/route.ts:1`), public openapi endpoint (`web/app/api/openapi/route.ts:10`), scoped api-key creation (`web/app/api/keys/route.ts:96`), and display apply commands (`web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:242`). the page should make that combined control-plane wedge impossible to miss.

3. **Page structure.**

1. hero - modify existing `HeroSection`. purpose: say what owlette is in one breath while keeping the brand line. why it earns scroll: visitors immediately know it is windows-only fleet operations, not a generic ai toy. visual: keep the owl eye and motion, but replace the rotating long-tail nouns with a compact proof strip. current headline stays because it is explicit brand code at `web/components/landing/HeroSection.tsx:47`.

2. live fleet proof - modify `ValuePropSection`. purpose: show the dashboard as the core control surface. why: the current "one dashboard" line is true but too broad (`web/components/landing/ValuePropSection.tsx:137`); the new text should name health, crashes, deploys, displays, and api actions. visual: same fast screenshot, no autoplay video. keep it static for lcp since `web/app/page.tsx:11` says the dashboard image is the lcp asset.

3. capability map - replace the current four-card `UseCaseSection`. purpose: compress the product inventory into six serious cards instead of four legacy verbs. why: current cards are monitor/control/deploy/converse only (`web/components/landing/UseCaseSection.tsx:9`, `web/components/landing/UseCaseSection.tsx:16`, `web/components/landing/UseCaseSection.tsx:23`, `web/components/landing/UseCaseSection.tsx:30`), so api, cli, sdk, display topology, pairing, offline behavior, and roles disappear. visual: dense two-row card grid on desktop, accordion on mobile.

4. display layouts that can undo themselves - new section. purpose: make the av/display differentiator concrete. why: a display manager with ack-or-revert is a real reason to choose owlette over scripts. visual: a simplified topology canvas, an "apply layout" button, and a 30-second acknowledgement countdown. code evidence supports the safety claim: `agent/src/display_manager.py:2559` to `agent/src/display_manager.py:2565` describes validation, sentinel persistence, apply, and watchdog rollback.

5. api, cli, and sdk - new section. purpose: prove owlette is programmable, not only a dashboard. why: developers need code before they believe the platform story. visual: three tabs, "rest", "cli", and "typescript", with real commands. the current app already exposes scalar docs (`web/app/docs/api/route.ts:3`) and a cached openapi spec (`web/app/api/openapi/route.ts:12`).

6. built for visible computers - compress `FeatureGrid`. purpose: keep the vertical recognition moment without letting it become the whole page. why: the current vertical list is useful but takes a full section for labels already familiar to the buyer (`web/components/landing/FeatureGrid.tsx:22`). visual: one horizontal band with verticals plus three workflow chips: venues, fleets, stages.

7. setup that works in the room - new section. purpose: explain how machines join and survive. why: 3-word pairing and offline recovery reduce adoption fear. visual: three steps: install, pair, run. evidence: the agent device-code route returns a "3-word human-readable phrase" (`web/app/api/agent/auth/device-code/route.ts:20`), and the current faq says the agent keeps monitoring offline (`web/components/landing/FAQSection.tsx:21`).

8. cortex, in context - modify, do not lead. purpose: show ai as an operator interface over real controls. why: the brand can mention ai, but "cortex" should not sound like the whole product. visual: short chat transcript beside executed command cards. current faq already explains bring-your-own-key (`web/components/landing/FAQSection.tsx:33`).

9. pricing - modify existing `PricingSection`. purpose: remove uncertainty and keep the low-friction beta offer. why: the current pricing is strong and clear (`web/components/landing/PricingSection.tsx:22`, `web/components/landing/PricingSection.tsx:41`), but the included list should add api, display management, scoped keys, and webhooks. visual: one plan, same no-tier stance.

10. short faq and footer - compress existing `FAQSection` and `LandingFooter`. purpose: answer blockers only. why: the current faq has useful answers, but jokes like mayonnaise (`web/components/landing/FAQSection.tsx:49`) should not compete with api/security/display claims this low on the page. visual: six questions max, then footer links.

4. **Hero copy.**

headline: `attention is all you need`

subheadline: `monitor, recover, deploy, automate, and safely reconfigure windows machines that have to keep showing up.`

primary cta label: `start free`

secondary cta label: `see the api`

supporting proof strip: `windows-only / free during beta / api, cli, sdk / display rollback / $10 per machine after beta`

if the secondary cta feels too developer-heavy in testing, use `explore the demo`; the current page already has that behavior under the dashboard screenshot (`web/components/landing/ValuePropSection.tsx:129`). i would not keep `sign in` as the hero secondary cta because it serves returning users, not persuasion (`web/components/landing/HeroSection.tsx:65`).

5. **Capability section.**

i would not surface the 10 capabilities as 10 equal cards. that makes the product feel unfocused. use six cards, with secondary capabilities in a proof rail underneath.

final card set:

- `keep processes alive` - `live cpu, memory, gpu, disk, alerts, and auto-restart when a windows process falls over.`
- `control every machine` - `start, stop, restart, reboot, and coordinate launch sequences without remoting into the box.`
- `ship software and content` - `push installers, configs, and project files to one machine or the whole site, with rollback where available.`
- `change displays safely` - `capture and apply layouts for screens, projector walls, and signage rigs with watchdog rollback if the room never confirms.`
- `automate the fleet` - `use scoped api keys, openapi, webhooks, the cli, and the typescript sdk from your own tools.`
- `ask cortex` - `ask what crashed, which driver is installed, or restart a process in plain language with your own ai key.`

secondary rail:

`multi-site roles` / `3-word pairing` / `offline local recovery` / `remote screenshots` / `unlimited log history` / `self-host option`

remote screenshots and unlimited log history are not in the brief inventory, but the current pricing list includes both (`web/components/landing/PricingSection.tsx:11`, `web/components/landing/PricingSection.tsx:13`), and the command api accepts `capture_screenshot` (`web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:137`). i would slot them as supporting proof, not headline cards.

6. **Developer story.**

this should be a dedicated section, placed immediately after display or immediately before it. my preference is after the capability map and before the verticals, because a skeptical developer needs proof before they hit pricing. headline: `script the fleet. keep the guardrails.` subcopy: `owlette's dashboard and api use the same controls: scoped keys, idempotent writes, webhooks, openapi, cli commands, and typed sdk calls. put it in a ci job, an incident bot, or your own control room ui.`

visual design: a dark code panel with three tabs and a right-side mini card showing "scoped key: machine=node-03:write", "idempotency: on", "response: 202 pending". this maps to real route behavior: the command endpoint documents idempotency, machine-scoped api-key scope, rfc 7807 errors, and a 202 response envelope (`web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:4` to `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:6`), and the implementation uses `withIdempotency` (`web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:352`).

rest sample:

```bash
curl -X POST "https://owlette.app/api/sites/site-1/machines/machine-a7f3/commands" \
  -H "authorization: bearer $OWLETTE_API_KEY" \
  -H "idempotency-key: restart-lobby-media-0428" \
  -H "content-type: application/json" \
  -d '{"type":"restart_process","params":{"process_name":"lobby media"},"timeout_seconds":60}'
```

cli sample:

```bash
npm install -g @owlette/cli
owlette auth login
owlette process restart --site site-1 --machine machine-a7f3 "lobby media"
```

the install and auth commands are already documented in the cli readme (`cli/README.md:8`, `cli/README.md:15`), and the cli explicitly covers machines, process lifecycle, scoped event streaming, webhook probes, and api identity (`cli/README.md:23`, `cli/README.md:28`, `cli/README.md:35`, `cli/README.md:36`, `cli/README.md:37`). for sdk copy, show a compact typescript snippet using the official package and the resource names from docs:

```ts
import { Roost } from "@owlette/sdk";

const roost = new Roost({ token: process.env.OWLETTE_API_KEY! });
await roost.processes("site-1", "machine-a7f3").restart("proc_lobby_media");
```

the sdk docs describe `@owlette/sdk` as zero-dependency and typed, with auto-retry, automatic idempotency keys, webhook verification, and a typed resource tree (`docs/api/sdk-node.md:4`, `docs/api/sdk-node.md:6`, `docs/api/sdk-node.md:76`, `docs/api/sdk-node.md:79`).

7. **Display management story.**

this gets its own section because it is the least generic capability and the strongest av wedge. headline: `change the wall without stranding the room.` subcopy: `capture a known-good layout, stage the new resolution, orientation, primary display, and monitor positions, then apply it with an acknowledgement timer. if owlette does not hear back, the agent restores the previous display config.`

section design: left side is a simplified display topology editor with monitor rectangles, resolution labels, orientation badges, primary marker, and an "apply with rollback" button. right side is a safety timeline: `validate -> snapshot -> apply -> wait for ack -> keep or revert`. this is not invented. the display manager says it applies via `SetDisplayConfig`, writes a revert snapshot to a sentinel, and starts a watchdog that rolls back if no ack arrives (`agent/src/display_manager.py:3` to `agent/src/display_manager.py:8`). it also returns apply ids and revert deadlines (`agent/src/display_manager.py:2201` to `agent/src/display_manager.py:2226`), while stale acks are rejected by matching the current apply id (`agent/src/display_manager.py:2890` to `agent/src/display_manager.py:2916`).

i would be careful with nvidia mosaic copy. the brief says mosaic is part of the display story, but current display code refuses remote apply while mosaic is active until explicit support lands (`agent/src/display_manager.py:2658` to `agent/src/display_manager.py:2666`). so the landing copy should say `mosaic-aware` and `detects mosaic state` unless the shipping build truly applies mosaic layouts. exact line: `handles windows display layouts, and is mosaic-aware so it does not blindly rewrite a wall it should not touch.`

8. **Cuts.**

cut the four old use-case cards as the main capability section. they were right for the old product, but they now hide the api and display manager. the current `UseCaseSection` also carries a large lightbox/zoom/pan implementation from `web/components/landing/UseCaseSection.tsx:40` through `web/components/landing/UseCaseSection.tsx:404`; replacing it with lighter cards buys room for the api and display sections while preserving page speed.

compress the vertical list. keep the labels from `FeatureGrid`, but do not spend a full scroll on eight industries and hover taglines (`web/components/landing/FeatureGrid.tsx:24` to `web/components/landing/FeatureGrid.tsx:60`). the new page should sell workflows, not just categories.

trim the faq from 12 to 6 questions: pricing, windows-only, offline behavior, security/scoped access, self-host/license, and ai key ownership. remove the mayonnaise question and reduce the extra joke density. the voice can stay dry, but the lower page now has more enterprise and developer proof to carry.

update the header. current nav has pricing, docs, download, sign in, get started (`web/components/landing/LandingHeader.tsx:25` to `web/components/landing/LandingHeader.tsx:37`). new nav should be `product`, `display`, `api`, `pricing`, `docs`, `download`, with sign in visually quieter.

9. **What you'd test.**

test hero subheadline emphasis: `monitor, recover, deploy, automate...` versus a more visual-ops line, `the control plane for windows machines your audience can see.` primary metric: register click-through from new visitors; secondary: demo/api click mix by referrer.

test section order for the two new wedges: display before api versus api before display. for av/search traffic, display-first should win. for docs/github/npm traffic, api-first may win. route by utm later if the split is meaningful.

run five qualitative sessions: two signage operators, one live-event engineer, one av display specialist, and one platform engineer. ask each to explain what owlette does after 30 seconds, then ask what they would trust it with and what they would not. the weak words will show up fast.

10. **Risks.**

the biggest risk is audience dilution. adding api, cli, sdk, webhooks, display topology, ai, deploys, and monitoring can make the page feel like a checklist. mitigation: one wedge sentence in the hero, six capability cards max, and two deeper proof sections only.

second risk: the display story may overpromise if mosaic apply is not actually production-ready. the code currently suggests mosaic is detected and protected, not fully rewritten (`agent/src/display_manager.py:2658`). mitigation: use "mosaic-aware" until the product owner confirms the exact shipping claim.

third risk: cutting the current playful faq could make the brand feel less weird and memorable. i would keep dry lowercase copy in microtext, but not let jokes occupy conversion-critical space. if early scroll-depth shows people miss the old tone, add one short human faq back near the footer, not in the hero or capability proof.
