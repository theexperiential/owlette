## 1. audience read.

The highest-conversion visitor in 2026 is the AV/show-control owner with Windows machines driving public screens, projector walls, LED processors, interactive exhibits, TouchDesigner boxes, Unreal nodes, or signage PCs. I rank them first because display topology management is not a nice-to-have for them; it is often the reason a system either comes back after a reboot or ruins a show. I would move them above the generic operator persona in the brief.

Second is the existing core buyer: the operator who needs to know whether every public-facing machine is alive, current, and recoverable without remoting into each box. The current page already speaks to them through the rotating hero nouns like "kiosks", "digital signage", "TouchDesigner PCs", and "Unreal Engine nodes" in `web/components/landing/HeroSection.tsx:10-20`.

Third is the developer or platform engineer. They may not buy first, but they can turn owlette into infrastructure if the page proves the API is real. Right now the header links to docs at `web/components/landing/LandingHeader.tsx:27-29`, but the page body never makes the API, CLI, SDK, scoped keys, idempotency, or webhooks part of the pitch.

## 2. the wedge.

Owlette wins because it is the only operator-friendly Windows fleet tool that treats a public screen machine as three things at once: a process host that must self-heal locally, a remote endpoint that humans and AI can control from anywhere, and an automatable platform with API/CLI/SDK access for teams that outgrow clicking. The sharpest differentiator is not "monitoring"; RMM tools and signage CMS products can claim that. The wedge is: "the same product that restarts your crashed media server in about 10 seconds can also safely apply a projector-wall layout with watchdog rollback, then expose the whole workflow to your own incident scripts." Every later section should prove that sentence from a different buyer angle.

## 3. page structure.

1. **landing header - modify.** Purpose: route three visitor types fast. Why it earns space: the current nav has pricing, docs, download, sign in, get started at `web/components/landing/LandingHeader.tsx:23-38`, but no body anchors for "api" or "displays". Visual: same compact fixed header, with links: `platform`, `api`, `display`, `pricing`, `docs`, `download`, `get started`.

2. **hero - keep the brand, rewrite the promise.** Purpose: make the product legible before the animation delights. Why: the current hero keeps the excellent headline at `web/components/landing/HeroSection.tsx:45-48`, but the subheadline is a rotating grammar trick built from verbs and nouns at `web/components/landing/HeroSection.tsx:9-20` instead of a clear promise. Visual: keep the owl eye, but shorten the hero from `h-[100dvh]` in `web/components/landing/HeroSection.tsx:24` to leave a hint of the command center below.

3. **proof strip - new.** Purpose: say "windows-only, beta-free, api-ready, display-safe" immediately. Why: Windows-only appears only in FAQ today at `web/components/landing/FAQSection.tsx:17-18`; the page should qualify visitors before they invest a scroll. Visual: four plain text chips under the hero CTA, not a card.

4. **command center - modify value prop.** Purpose: show the dashboard as the center of the system. Why: the current screenshot is already LCP-prioritized at `web/components/landing/ValuePropSection.tsx:105-112` and links to the live demo at `web/components/landing/ValuePropSection.tsx:123-130`; keep that asset but put clearer surrounding copy on it. Visual: dashboard screenshot with three callout pins: "recover", "control", "deploy".

5. **what owlette runs - replace current use-case cards.** Purpose: surface the whole capability map without making visitors open accordions. Why: today `UseCaseSection` only has four cards, `monitor/control/deploy/converse`, at `web/components/landing/UseCaseSection.tsx:7-36`; API, CLI, SDK, display topology, pairing, offline survival, and RBAC are missing. Visual: six compact cards plus a small "ops guarantees" row.

6. **display layouts that can undo themselves - new.** Purpose: give AV specialists the decisive differentiator. Why: the implementation has a real write path with revert snapshots and watchdog rollback in `agent/src/display_manager.py:3-8`, and the public route exposes capture, auto-restore, reset breaker, and remote apply operations in `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:11-18`. Visual: a monitor topology diagram beside a small event timeline: capture -> apply -> ack -> rollback if no ack.

7. **script the fleet - new.** Purpose: prove owlette is not just a dashboard. Why: docs exist through the Scalar API reference route at `web/app/docs/api/route.ts:1-12`, and display API routes enforce machine-scoped write permissions plus required idempotency at `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:8-9`. Visual: tabbed code block for curl, TypeScript SDK, CLI, plus a webhook event example.

8. **built for the rooms where a reboot is expensive - compress feature grid.** Purpose: preserve vertical recognition without letting verticals be the whole story. Why: the current `FeatureGrid` lists eight verticals at `web/components/landing/FeatureGrid.tsx:22-63`, which is useful but thin. Visual: one dense line of verticals plus three short scenario blurbs: lobby signage, museum interactives, projection stage.

9. **pricing - keep, update inclusions.** Purpose: remove procurement anxiety. Why: the current pricing is clean and memorable, with "$10 /machine/month" struck through and "free during beta" at `web/components/landing/PricingSection.tsx:32-42`. Visual: same single plan, but include API, display layouts, and AGPL-3.0 self-host note. Also reconcile the footer license, which currently shows `FSL-1.1-Apache-2.0` at `web/components/landing/LandingFooter.tsx:64-66` while the brief says AGPL-3.0.

10. **questions, answered - compress.** Purpose: answer trust blockers, not run a comedy appendix. Why: the current FAQ has useful operational answers around offline behavior, firewall, security, cortex, sites, and self-hosting at `web/components/landing/FAQSection.tsx:21-54`, but jokes like "if a kiosk crashes..." and mayonnaise at `web/components/landing/FAQSection.tsx:37-50` push high-intent developers away. Visual: eight accordion rows.

11. **footer - keep, tighten.** Purpose: legal, contact, docs, GitHub. Why: the current footer has the brand line at `web/components/landing/LandingFooter.tsx:29-35`; keep that. Visual: no random emoji rotation for the marketing page if we want more enterprise trust, or keep it only after validation.

## 4. hero copy.

Headline:

`attention is all you need`

Subheadline:

`monitor, recover, deploy, automate, and safely reconfigure windows machines that run public screens, shows, kiosks, exhibits, and media systems.`

Primary CTA:

`get started free`

Secondary CTA:

`explore the live demo`

Small proof line under CTAs:

`windows-only. free during beta. $10/machine/month after. api, webhooks, cli, sdk, and agpl self-hosting included.`

I would keep the headline because it is already the brand signifier and appears in both hero and footer (`web/components/landing/HeroSection.tsx:46-48`, `web/components/landing/LandingFooter.tsx:33-35`). I would remove "sign in" as the hero secondary CTA; it exists at `web/components/landing/HeroSection.tsx:64-66`, but first-time visitors need proof, not authentication.

## 5. capability section.

The page should not show ten equal cards. Equal cards make the product feel unfocused. I would present six primary cards, then an "ops guarantees" rail for supporting capabilities. The primary cards are what a buyer can picture using; the rail is what makes the system credible.

Final card set:

| card label | one-sentence tagline |
| --- | --- |
| `watch & recover` | `track cpu, memory, gpu, disk, and process health in real time, then restart crashed processes before the room notices.` |
| `control` | `start, stop, restart, reboot, and sequence processes across any site without opening remote desktop.` |
| `deploy` | `push software, configs, and content to one machine or a whole fleet, with rollback-ready project distribution where it belongs.` |
| `ask cortex` | `ask what crashed, which driver is installed, or where to restart a service, using your own openai, anthropic, or compatible key.` |
| `automate` | `use scoped api keys, webhooks, openapi docs, the cli, and the typescript sdk to build owlette into your own tools.` |
| `display layouts` | `capture and apply windows display topologies, including mosaic-aware setups, with watchdog auto-revert when a layout is not acknowledged.` |

Ops guarantees rail:

`3-word pairing`, `bulk silent install`, `multi-site roles`, `offline local recovery`, `email and webhook alerts`, `remote screenshots`, `process scheduling`, `log history`.

I found a few current-page capabilities that the brief underplays: remote screenshots, process scheduling with automatic reboots, and unlimited log history are listed in pricing at `web/components/landing/PricingSection.tsx:10-13`. I would not promote them to top-level cards, but they are valuable proof points in the rail and FAQ.

What gets cut from this section: none of the ten inventory capabilities disappear. Roost should stay a phrase inside `deploy`, not a card, because the brief says it is in flight. Pairing, RBAC, and offline survival should not become separate cards because they are trust mechanics, not the first sentence of the product.

## 6. developer story.

Headline:

`script the fleet, don't screen-share into it.`

Subcopy:

`owlette has the dashboard for humans and the api surface for everything else: scoped keys, idempotent writes, webhooks, openapi docs, a cli, and a typescript sdk. wire restarts into incident response, trigger deployments from ci, or let your product check whether the machine in the lobby is actually alive.`

This section should slot after display management in the main order, with a header anchor so developers can jump there from the nav. Display deserves earlier body placement because it is the more visual differentiator, while developers are more likely to use the nav/docs CTA. The section should look like a sober docs panel: dark code block on the right, four bullets on the left, and tabs for `curl`, `typescript`, `cli`, `webhook`.

Code samples to show:

```bash
curl -X PUT "https://owlette.app/api/sites/$SITE_ID/machines/$MACHINE_ID/display-layout" \
  -H "authorization: bearer $OWLETTE_API_KEY" \
  -H "idempotency-key: display-apply-2026-04-29" \
  -H "content-type: application/json" \
  -d '{"op":"set_remote_apply","enabled":true}'
```

```ts
import { Owlette } from "@owlette/sdk";

const owlette = new Owlette({ apiKey: process.env.OWLETTE_API_KEY! });

await owlette.machines.processes.restart({
  siteId: "main-stage",
  machineId: "node-03",
  processId: "media-server",
});
```

```bash
npx @owlette/cli machines list --site main-stage
npx @owlette/cli processes restart media-server --machine node-03
```

The SDK and CLI samples should be checked against the actual package API before implementation, but the landing page needs this level of specificity. The curl sample can be grounded directly in the current display route, which documents the endpoint and operations at `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:5-18`. The section should include a small CTA pair: `open api reference` and `install the cli`. The API reference is real enough to advertise because `web/app/docs/api/route.ts:3-12` mounts an interactive Scalar reference against `/api/openapi`.

## 7. display management story.

Headline:

`fix the wall without risking the wall.`

Subcopy:

`capture the display layout that works, apply it when windows or a driver forgets, and let owlette roll back automatically if the machine does not acknowledge the change. built for projector blends, signage arrays, mosaic rigs, and the lonely pc behind the screen.`

This should be the most opinionated new section because it is the clearest product expansion. The current landing page never says "display" except generic nouns like digital signage; the brief says topology management is a differentiator. The code supports making a bold claim: `display_manager.py` says the write path validates the desired layout, applies it through `SetDisplayConfig`, persists a revert snapshot, and starts a watchdog thread that rolls back if no acknowledgement arrives (`agent/src/display_manager.py:3-8`). It also explicitly acknowledges Mosaic detection through the NVAPI layer (`agent/src/display_manager.py:10-12`).

Design: left side is a clean topology canvas with rectangles labelled `projector 1`, `projector 2`, `operator`, `primary`, and a small mosaic badge. Right side is a command timeline:

`capture known-good layout`

`apply layout remotely`

`wait for acknowledgement`

`auto-revert if the screen goes dark`

Below the timeline, show three plain proof chips: `resolution`, `orientation`, `primary display`, plus `nvidia mosaic` if detected. Avoid a heavy video. If interaction is desired, make it a lightweight CSS state switch between "good layout", "bad apply", and "rolled back"; no canvas dependency is needed.

Placement: immediately after the capability section, before the developer section. This tells operators "this is not just process monitoring" before asking them to parse code. It also gives developers a concrete high-risk workflow that the API can automate later.

## 8. cuts.

Cut the rotating hero sentence as the main explanation. It is charming, but `RotatingWord` hides meaning and cannot carry API/display positioning (`web/components/landing/HeroSection.tsx:51-56`). Keep the animation only as a smaller flourish if performance stays clean.

Compress the current `UseCaseSection`. It is expensive in attention: four cards, expanded preview copy, shared preview, lightbox, zoom, pan, arrows, dots, and keyboard handling across `web/components/landing/UseCaseSection.tsx:38-407`. That complexity still only explains four legacy verbs. Replace it with visible cards and reserve screenshots for the command center.

Compress the vertical list. The current `FeatureGrid` has useful market language, but an eight-item "built for" list at `web/components/landing/FeatureGrid.tsx:22-63` should move below the product proof. Vertical recognition helps, but it does not prove owlette is better.

Cut or rewrite the weakest FAQ jokes. Keep the lowercase dry voice, but remove the mayonnaise row and the "body" line in the auto-recovery answer (`web/components/landing/FAQSection.tsx:29-30`, `web/components/landing/FAQSection.tsx:49-50`). The page can be odd without making security-conscious readers wonder whether the product is unserious.

Update pricing inclusions. The current included list stops before API/CLI/SDK and display topology (`web/components/landing/PricingSection.tsx:5-15`). The pricing card should say those are included during beta, with cortex still marked BYO key.

## 9. what you'd test.

1. Hero clarity test: compare the proposed direct subheadline against a more operator-flavored line, `owlette keeps every windows machine behind your screens alive, current, and recoverable.` Measure primary CTA clicks, demo clicks, and scroll depth to the capability section.

2. Section-order test: display story before developer story versus developer story before display story. Segment by referrer: docs/GitHub traffic should tolerate API earlier; direct and paid search traffic may need visual differentiation first.

3. Qualitative five-person test with two AV operators, two developers, and one museum/signage operator. Ask each person after 30 seconds: "what does owlette do that your current tool does not?" If the answers do not mention either display rollback or API automation, the page is still too generic.

## 10. risks.

The main risk is that this proposal makes owlette feel broader and more serious, which could dilute the current page's weird charm. The owl eye, lowercase voice, and "attention is all you need" should preserve enough of the brand, but the jokes need to move behind the proof.

Second risk: developers may punish any SDK or CLI sample that does not match the real package API. Before implementation, the SDK and CLI snippets need to be verified against `@owlette/sdk` and `@owlette/cli`. If they are not ready, show curl plus the interactive API reference first and make SDK/CLI a smaller install note.

Third risk: display management could over-index the page toward AV specialists and confuse simple kiosk operators. If early scroll heatmaps show visitors skipping the display section, shrink it into the capability grid and move "watch & recover" proof higher again. I would not make that cut preemptively; the display manager is the rare feature that competitors will have trouble copying quickly.
