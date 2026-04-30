## 1. audience read.

the highest-conversion visitor is still the operator responsible for windows machines that must keep running in public: digital signage, museums, attractions, events, corporate av, virtual production, and interactive retail. they have budget because downtime is visible, embarrassing, and often expensive. second is the av/show-control specialist managing projector walls, led processors, mosaic desktops, and weird multi-monitor rooms; display topology makes owlette feel like it was built by someone who has actually been stranded by a bad layout. third is the developer or platform engineer who wants fleet control inside scripts, ci, internal tools, or incident response. they will not convert on vibes, but they may become the internal champion if the api looks real.

the current page over-serves persona one and almost hides personas two and three. the hero rotates through operational nouns like "kiosks", "digital signage", "touchdesigner pcs", and "node.js servers" [web/components/landing/HeroSection.tsx:9], [web/components/landing/HeroSection.tsx:10], but the page structure still lands as monitor/control/deploy/converse only [web/components/landing/UseCaseSection.tsx:7]. in 2026, the page should say: this is windows fleet operations for people whose machines drive real rooms.

## 2. the wedge.

owlette wins because it combines operator-friendly windows recovery with programmable fleet control and display-topology safety in one product. hand-rolled scripts can restart apps, but they do not give you scoped api keys, webhooks, openapi, role-based sites, and a dashboard. enterprise signage or av platforms can be powerful, but they are expensive, closed, and often built around content playlists rather than arbitrary windows processes. rmm tools can manage machines, but they are not tuned for show PCs, projector walls, touchdesigner, unreal, kiosks, and the specific fear that a remote display change will black-screen the room. the page should anchor on "windows fleets that run public experiences" and prove three things quickly: owlette keeps the software alive, lets teams automate it, and can change display layouts without stranding the machine.

## 3. page structure.

1. **header, modified.** purpose: route three intent types without clutter. why it earns its fixed space: the current header has pricing, docs, download, sign in, get started [web/components/landing/LandingHeader.tsx:23], but no api or display anchor. visual: same compact bar; links become `product`, `api`, `display`, `pricing`, `docs`, `download`, with `get started` as the only filled button.

2. **hero, keep and sharpen.** purpose: preserve the brand line while stating the product category immediately. why: "attention is all you need" already has ownership in the current hero [web/components/landing/HeroSection.tsx:46], but the rotating sentence is too diffuse for the expanded product. visual: keep the eye, but put a static subheadline under it and a small windows-only note. cut the rotating-word dependency for speed and clarity.

3. **fleet screenshot, modified from value prop.** purpose: show the dashboard before explaining every capability. why: the current screenshot is already treated as lcp-priority content [web/components/landing/ValuePropSection.tsx:105], [web/components/landing/ValuePropSection.tsx:111], and "explore the live demo" is a useful trust path [web/components/landing/ValuePropSection.tsx:123]. visual: keep the dashboard, reduce the 3d tilt intensity, and add three small annotations: `crash restarted`, `webhook delivered`, `display layout pending ack`.

4. **capability spine, replace use-case accordion.** purpose: group the product into six understandable jobs instead of four old nouns. why: current cards omit api, sdk, display, pairing, rbacs, and offline survival even though they are now core. visual: six dense cards with icons, one sentence each, and one compact screenshot strip. this replaces `UseCaseSection`.

5. **local survival and recovery.** purpose: answer the operator's main objection: what happens when the cloud or venue internet fails. why: the faq currently explains offline survival well [web/components/landing/FAQSection.tsx:21], [web/components/landing/FAQSection.tsx:22], but it is buried near the bottom. visual: a small timeline: process crashes, agent notices, restart happens in about 10 seconds, cloud sync resumes later.

6. **display topology manager, new.** purpose: give av/show-control buyers their deciding feature. why: the route already supports capture, auto-restore, breaker reset, and remote apply operations [web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:11], [web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:17]. visual: side-by-side before/after monitor layout with a watchdog countdown and "acknowledged" state.

7. **api, cli, and sdk, new.** purpose: make developers believe the platform is real. why: the app ships an interactive scalar api reference at `/docs/api` backed by `/api/openapi` [web/app/docs/api/route.ts:3], [web/app/docs/api/route.ts:4], and the openapi endpoint is public and cached [web/app/api/openapi/route.ts:10], [web/app/api/openapi/route.ts:25]. visual: dark code panel plus webhook event sample and links to api reference and sdk.

8. **built for rooms, not just servers, compressed from feature grid.** purpose: keep vertical relevance without eating a whole section. why: the current vertical list is accurate but generic [web/components/landing/FeatureGrid.tsx:22], [web/components/landing/FeatureGrid.tsx:63]. visual: one horizontal band with four grouped use cases: public screens, immersive rooms, live production, internal tools.

9. **pricing and self-host, modified.** purpose: remove uncertainty. why: pricing is already simple and strong [web/components/landing/PricingSection.tsx:21], [web/components/landing/PricingSection.tsx:41], but the included list omits api and display while mentioning remote screenshots, which is a useful discovered capability [web/components/landing/PricingSection.tsx:11]. visual: single tier stays, feature list updates to include api keys, webhooks, display layouts, cli/sdk, and remote screenshots. add "windows-only" and "agpl-3.0 self-host" near the tier.

10. **faq plus final cta, compressed.** purpose: handle security, windows-only, beta pricing, cortex keys, self-hosting, and firewall questions. why: the current 12-question faq has good operational answers but too much joke density for developer and av buyers. visual: six accordions and a final cta row.

## 4. hero copy.

headline:

`attention is all you need`

subheadline:

`monitor, recover, deploy, automate, and reconfigure windows machines that run real-world screens, rooms, and shows.`

supporting microcopy:

`windows-only. free during beta. built for operators, av teams, and developers who need machines to come back without a site visit.`

primary cta label:

`get started free`

secondary cta label:

`explore the live demo`

tertiary text link under ctas:

`read the api docs`

i would keep the headline because it is the brand asset and already anchors both the hero and footer [web/components/landing/LandingFooter.tsx:33], [web/components/landing/LandingFooter.tsx:34]. i would replace the secondary `sign in` cta in the hero [web/components/landing/HeroSection.tsx:64] with `explore the live demo`; sign-in belongs in the header, while the hero needs a non-commitment proof path for skeptical visitors.

## 5. capability section.

the capability section should not try to list ten unrelated features as ten equal cards. that would make the product look sprawling. i would use six cards, then give api and display their own sections because they are both conversion wedges.

final card set:

1. `watch every process` - `live cpu, memory, gpu, disk, logs, screenshots, and thresholds for the windows apps that matter.`

2. `bring it back` - `restart crashed processes in about 10 seconds, reboot machines, and keep recovery running locally when the internet drops.`

3. `control the fleet` - `start, stop, restart, schedule, and sequence processes across one machine, one site, or the whole organization.`

4. `ship updates quietly` - `silently install software, configs, and content across machines, with atomic project distribution and rollback as roost matures.`

5. `ask cortex` - `use natural language for questions and actions like "what crashed at 3am?" or "restart the media server on node 3."`

6. `organize the mess` - `group machines into sites, invite collaborators by role, pair agents with three-word codes, and bulk-install without logging into the target.`

what gets one-liners elsewhere: scoped api keys, webhooks, openapi, cli, and sdk are teased on cards but explained in the developer section. display layout capture, nvidia mosaic, remote apply, and watchdog rollback are teased on the capability strip but explained in the display section. pricing and self-hosting stay in pricing/faq. nothing from the brief gets cut; the only demotion is roost, because the brief says it is in flight and should not headline.

section headline:

`one control plane for the windows machines nobody can ignore.`

section intro:

`owlette watches the app, the machine, the site, and the shape of the screens around it. when something drifts, it can tell you, fix it, or let your own tooling take over.`

## 6. developer story.

i would make this a dedicated section after display management, not an aside. developers are a new persona with a different trust model, and the current page only gestures at "a full api" inside the control card [web/components/landing/UseCaseSection.tsx:16], [web/components/landing/UseCaseSection.tsx:17]. that is not enough for someone evaluating integration quality.

headline:

`script the fleet like it belongs to you.`

body copy:

`use scoped api keys, idempotent writes, webhooks, openapi, @owlette/cli, and @owlette/sdk to make owlette part of your own runbooks, ci jobs, and incident flows. no screen-scraping. no shared admin password.`

visual: a two-tab code panel. tab one is rest; tab two is typescript. a small right rail shows "scoped to site: vegas", "idempotency-key required", "webhook: process.crashed delivered". the section should link to `/docs/api`, because the scalar reference exists and points at `/api/openapi` [web/app/docs/api/route.ts:1], [web/app/docs/api/route.ts:4].

rest sample:

```bash
curl -X PUT "https://owlette.app/api/sites/$SITE_ID/machines/$MACHINE_ID/display-layout" \
  -H "authorization: bearer $OWLETTE_API_KEY" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"op":"set_remote_apply","enabled":true}'
```

typescript sample:

```ts
import { owlette } from "@owlette/sdk";

const client = owlette({ apiKey: process.env.OWLETTE_API_KEY! });

await client.processes.restart({
  siteId: "site_vegas",
  machineId: "node-03",
  processId: "media-server",
  idempotencyKey: crypto.randomUUID(),
});
```

the typescript shape is proposed landing-page copy, so it should be checked against the actual sdk before implementation. if the sdk surface differs, the marketing sample should follow the real package rather than invent a prettier api.

## 7. display management story.

this should be the most opinionated new product section and it should appear before the developer section. display management is visually understandable to non-developers, differentiated from generic monitoring tools, and emotionally sharp: a bad remote display change can strand a kiosk, video wall, or control machine. the api route confirms the product has capture, set-auto-restore, reset-breaker, and set-remote-apply operations [web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:13], [web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:17], with machine write scope and idempotency [web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:43], [web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:70].

headline:

`change the wall without bricking the room.`

body copy:

`capture known-good windows display layouts, apply them remotely, manage orientation and primary displays, and handle nvidia mosaic setups with a watchdog. if the agent cannot confirm the new layout, owlette rolls back instead of leaving the machine unreachable.`

visual: an interactive but lightweight css diagram, not a video. left side: current layout with four monitors and labels like `projector 1`, `projector 2`, `operator`, `touch`. right side: proposed layout with one tile highlighted in amber. bottom status rail cycles through `sent`, `applying`, `waiting for ack`, `acknowledged`, and on hover shows `auto-revert if no ack`. mobile collapses this to a vertical before/after card and the status rail.

supporting bullets:

`capture a layout that works.`

`apply it later across the right machine, not the whole fleet by accident.`

`recover from a bad layout without asking someone to find a keyboard in the ceiling.`

this section should not overclaim. say "windows display configurations" and "nvidia mosaic support"; do not imply led processor configuration, color calibration, or projector warp/blend unless those are real.

## 8. cuts.

cut the rotating hero sentence. it is clever, but the expanded product now needs a clear category sentence above the fold. keep the eye and headline, lose the word roulette.

compress the 3d tilt screenshot. the current value section spends a lot of visual energy on the dashboard [web/components/landing/ValuePropSection.tsx:90], [web/components/landing/ValuePropSection.tsx:101]. keep the screenshot, but reduce animation and use annotations to teach the new surfaces.

replace the four-card use-case section. `monitor`, `control`, `deploy`, and `converse` were right for the older product [web/components/landing/UseCaseSection.tsx:7], [web/components/landing/UseCaseSection.tsx:36], but they now hide api, display, pairing, roles, and offline behavior.

compress the vertical list. the current "built for" band lists eight industries [web/components/landing/FeatureGrid.tsx:22], [web/components/landing/FeatureGrid.tsx:63]. keep the proof of relevance, but stop presenting verticals as the main information architecture.

trim faq jokes. keep the dry lowercase voice, but remove the lowest-signal questions like mayonnaise [web/components/landing/FAQSection.tsx:49] and the philosophical kiosk joke [web/components/landing/FAQSection.tsx:37]. keep windows-only, offline, firewall, security, cortex, pricing, and self-hosting. also resolve the license mismatch before publishing: the brief says agpl-3.0 self-hosting, while the current footer links `FSL-1.1-Apache-2.0` [web/components/landing/LandingFooter.tsx:64], [web/components/landing/LandingFooter.tsx:65].

## 9. what you'd test.

1. hero category test: `windows fleet operations for screens, rooms, and shows` versus my proposed `monitor, recover, deploy, automate, and reconfigure...` subheadline. success metric: register clicks and demo clicks from first-time visitors, segmented by referrer.

2. section order test: display before developer versus developer before display. success metric: api docs clicks, pricing scroll depth, and registrations from visitors who interact with those sections.

3. qualitative five-person test: two operators, two av specialists, one developer. ask each to explain what owlette does after 30 seconds, what they think it replaces, and what would stop them from installing the agent. if they cannot name display safety or api automation unprompted, the new sections are too subtle.

## 10. risks.

the main risk is that the page becomes too broad. by trying to speak to operators, av teams, and developers, it could lose the emotional simplicity of "your machines crash, owlette brings them back." if early metrics show lower hero cta clicks, i would move recovery/offline survival higher and push api into a narrower proof panel.

the second risk is that display management may feel niche to the broader signage buyer. i still think it deserves a major section because it is the clearest differentiator, but i would track interaction with the display section separately. if it underperforms, keep it as a strong card and let developer automation move above it.

the third risk is credibility. the page must not show sdk methods, webhook names, or display guarantees that the actual product cannot support. before implementation, every code sample and display phrase should be checked against the real sdk, cli, and agent behavior. the marketing page should sound confident because the product is specific, not because the copy outruns the code.
