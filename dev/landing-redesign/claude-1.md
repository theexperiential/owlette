# landing redesign — claude-1

## 1. audience read

In 2026, three personas land on owlette.app and they convert at very different rates. Ranked by likely conversion value:

1. **the AV / show-control specialist running displays.** Theme park tech leads, museum AV managers, virtual production stage engineers, projection-mapping operators, signage integrators. They arrive after a black-screen incident or a driver update that scrambled a video wall. They have budget, urgency, and a specific question: *can this thing apply a Mosaic layout without bricking a kiosk?* If the answer is yes and visible in 10 seconds, they trial. Highest conversion value because they install on dozens of machines per site.
2. **the operator-engineer hybrid.** The TouchDesigner / Unreal / Notch person who already manages a fleet with hand-rolled batch files and TeamViewer. They want to stop being the on-call. They are price-sensitive but loyalty-rich — they will tell ten friends. The current page already speaks to them; we do not lose them.
3. **the platform / devops engineer** evaluating whether to embed owlette into an internal tool, an event runbook, or a CI pipeline. They will not read marketing copy. They want to see a `curl` command, an SDK snippet, an OpenAPI link, and bounce to docs. Low individual conversion rate, but each one who converts brings a fleet.

The current page (`web/components/landing/FeatureGrid.tsx:22-63`) only addresses persona #2.

## 2. the wedge

**Owlette is the only fleet tool a show-control operator can run themselves and a platform engineer can script against — and it is the only one that treats the Windows display topology as a first-class, transactionally-safe object.** Hand-rolled scripts have no UI, no auth, no rollback. Enterprise signage CMS (Userful, Scala, BrightSign Network) cost six figures, hide behind sales calls, and treat your TouchDesigner PC as an anomaly. RMM tools (NinjaOne, Atera) monitor uptime but cannot apply a Mosaic layout, cannot atomically deploy a project, and cannot be talked to in English. Owlette is the cheap, scriptable, AI-native middle — and the watchdog-protected display engine (`web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:1-22`) is the moat. Every section below is graded against: *does this make the wedge sharper?*

## 3. page structure

Order, top to bottom. Eight sections — tight, no fat.

1. **hero** — keep, refresh subhead. *Earns scroll because the eye + animated rotator are already best-in-class at this price tier and "attention is all you need" is the brand.* On screen: animated owl eye, headline, rotating sentence, two CTAs, plus a new third line — a tiny **"windows only · free during beta · self-host on AGPL"** strip directly under the CTAs so Mac/Linux visitors bounce *now* and don't burn 60 seconds.
2. **dashboard hero shot** — keep `ValuePropSection.tsx`'s 3D-tilt `dashboard.png`. *Earns scroll because nothing converts a fleet operator like seeing 10 tiles of green/yellow/red they recognise.* Modify the headline to one that does double duty for AV+ops (see §5).
3. **what owlette does** (replaces `UseCaseSection.tsx`) — five-card capability grid: monitor, control, deploy, **display**, converse. *Earns scroll because we add the wedge card (display) and demote nothing.* Same lightbox interaction as `web/components/landing/UseCaseSection.tsx:38-409` — a great pattern, just one more card.
4. **display topology — the section nobody else has** (NEW). *Earns scroll because it's the single capability that closes a $30k Userful comparison.* See §7.
5. **built for builders — API, CLI, SDK** (NEW). *Earns scroll because it converts persona #3 in 15 seconds with one code block.* See §6.
6. **built for** (keep `FeatureGrid.tsx`, compress) — verticals chip strip. *Earns scroll because someone in "worship" needs to see the word "worship" to feel the page is about them.* Trim from 8 verticals to 6, drop the rollover tagline (move to alt text).
7. **pricing** — keep `PricingSection.tsx`, add one line about API access being included. *Earns scroll because $10/machine with no tiers is itself the pitch.*
8. **faq** — keep, cut from 12 to 8. *Earns scroll because the SpongeBob bit is brand DNA, but six of the questions are filler.* See §8.

**Cut:** the `FeatureGrid` rollover tagline behavior (decorative, slow), and the pricing card's `text-base sm:text-lg font-medium ... everything included` middle row (`PricingSection.tsx:61-63`) which adds vertical noise.

**Kept-as-is:** hero eye, dashboard 3D tilt, FAQ accordion behavior, footer.

**New:** display section (#4), developer section (#5), the under-CTA platform strip in hero.

## 4. hero copy

Keep the headline. The wordplay is load-bearing brand and the file-level comment in `HeroSection.tsx:46-48` makes clear it's deliberate.

- **headline:** `attention is all you need`
- **subheadline (revised rotator):** keep the rotator, but expand the prefix list and tighten the suffix list to better cover all three personas.
  - prefixes: `monitor`, `script`, `deploy software to`, `lay out displays on`, `ask cortex about`, `remotely control`
  - suffixes: `kiosks`, `digital signage`, `interactive exhibits`, `media servers`, `projector walls`, `LED arrays`, `TouchDesigner PCs`, `Unreal Engine nodes`, `the whole fleet`
  - The new prefix `lay out displays on` and suffix `projector walls` / `LED arrays` plant the display flag in the first 5 seconds. The new prefix `script` plants the API flag.
- **primary CTA:** `get started — free during beta` (current is just `get started` at `HeroSection.tsx:62`; adding the inline price kills a downstream objection)
- **secondary CTA:** `see a live demo` (linking to `/demo` — currently the demo link is buried in `ValuePropSection.tsx:124-128`. Promote it. `sign in` belongs in the header, not the hero.)
- **micro-strip under CTAs (new):** `windows only · free during beta · agpl self-host · no credit card`

## 5. capability section

Ten capabilities, one section, no overcrowding — group them.

**Five top-line cards** (same lightbox interaction as `UseCaseSection.tsx:38-409`, one card wider):

| label | one-sentence tagline |
|---|---|
| **monitor** | live cpu, gpu, memory, and disk on every machine — with email and webhook alerts the second something drifts. |
| **control** | start, stop, restart, reboot — one machine or your entire fleet, from anywhere, in one click or one curl. |
| **deploy** | push software, configs, and project files atomically — with rollback, so a bad build never strands a kiosk. |
| **display** | apply windows display layouts (resolution, orientation, mosaic) with a watchdog that auto-reverts if the screen goes black. |
| **converse** | talk to your fleet in plain english with cortex — bring your own openai or anthropic key. |

**Capabilities folded into prose** (not their own card):

- *Auto-recovery* (#1 in inventory) is collapsed into the **monitor** tagline and called out specifically in the FAQ. It's not a feature, it's table stakes; promoting it dilutes the wedge.
- *Multi-site & RBAC* (#8) and *pairing UX* (#9) live as one-liners under the **control** card's expanded view ("invite collaborators per site, pair agents with a 3-word phrase, bulk silent install supported").
- *Offline survival* (#10) becomes a single FAQ — it's reassurance, not a wedge.
- *roost* (#3, in flight) lives as one bold sentence inside the **deploy** card's expanded view: *"content-addressed sync with atomic deploy and one-command rollback (in beta)."* Per the brief, no top-billing.

This is a deliberate inversion of the current 4-card grid (`UseCaseSection.tsx:7-36`). Display gets a card; auto-recovery loses one. Display is the wedge; auto-recovery is the floor.

## 6. developer story

**Headline:** `script your fleet like infrastructure.`
**Subhead:** `a real REST API, idempotency keys, scoped tokens, an openapi spec, a typed sdk, and a cli. owlette is the rare ops tool that doesn't make you click.`

**Placement:** section 5 — *after* the capability grid, *before* verticals. Rationale: the operator persona needs to first believe the product *does the things*, then a subset of them learns "oh, I can also script it." Putting it earlier loses the operator. Putting it later (after FAQ) loses the developer who never made it that far.

**Visual:** three-column code tabs (cli / typescript sdk / curl), one example each, all doing the same thing — restarting a process — so the developer immediately sees the symmetry. Plus a fourth tab that links to the OpenAPI spec.

```bash
# cli
$ owlette process restart media-server --site main-stage
✓ restarted media-server on node-3 (idempotent)
```

```ts
// @owlette/sdk
import { Owlette } from '@owlette/sdk';
const o = new Owlette({ apiKey: process.env.OWLETTE_KEY });
await o.processes.restart({ site: 'main-stage', name: 'media-server' });
```

```bash
# curl — same call, with a real idempotency key
curl -X POST https://owlette.app/api/sites/main-stage/processes/media-server/restart \
  -H "Authorization: Bearer $OWLETTE_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

Below the tabs, four tiny chips, each linking out: `openapi spec` · `typescript sdk` · `cli on npm` · `webhook events`. No marketing prose around them — devs trust links, not paragraphs.

**Why I am NOT killing this section and weaving it inline:** weaving means the platform engineer has to construct the value prop from fragments. They won't. They need one screen that says *we are a real API company*, then they self-serve. The cost is one extra section; the gain is a cohort the current page does not capture at all.

The idempotency key in the curl sample is real — see `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:62-71` — and that authenticity matters because devs will paste this into a terminal in week one.

## 7. display management story

**Headline:** `windows displays without the panic.`
**Subhead:** `read, save, and apply mosaic + multi-monitor layouts to any machine. atomic apply with watchdog auto-revert: if the screen doesn't come back in 30 seconds, the previous layout is restored. nobody walks to the rack.`

**Placement:** section 4 — *immediately after* the capability grid. Rationale: it is the wedge, and the AV specialist who arrived after a black-screen incident needs to see this in their first 20 seconds of scrolling or they're back on their search results.

**Visual:** a side-by-side animated diagram (svg + css, no video — keeps the page light) showing the lifecycle:

```
  [ proposed layout ] ──apply──▶ [ watchdog: 30s ]
                                       │
                              ┌────────┴────────┐
                              ▼                 ▼
                     ack received        no ack / black screen
                              │                 │
                              ▼                 ▼
                          committed       auto-reverted
```

Underneath the diagram, three short bullets:

- **mosaic-aware** — read the current nvidia mosaic config, save it as a named layout, apply it elsewhere.
- **transactional** — every apply is idempotent and reversible (`Idempotency-Key` is required, not optional).
- **fleet-wide** — assign one layout to every kiosk in a site; new machines self-configure on first boot.

A small footer line on the section: *"the same engine drives the dashboard, the api, and the cli — `owlette display apply layout-name --site main-stage`."*

**Why this is its own section, not a card:** the display capability is the #1 reason an AV specialist picks owlette over Userful. A card-sized treatment buries the watchdog/rollback story, which is the whole point. A full section earns its weight in conversions from the highest-value persona.

**Cost:** one extra section above the fold of "scroll fatigue." I compensate by collapsing FeatureGrid (cut 2 verticals), and by killing the second blurb in `ValuePropSection.tsx:135-144` (the "owlette lets you monitor..." paragraph below the dashboard image — the rotator already said this).

## 8. cuts

- **FAQ: drop 4 of 12.** Cut: "is mayonnaise an instrument", "if a kiosk crashes and nobody's there to see it", "what's the difference between a site and a machine", "can i self-host it" (last one moves into the under-CTA strip + footer link, since it's a buying objection not a Q). Keep mayonnaise → no, actually, keep mayonnaise. Cut the kiosk koan and the "is it actually free" question (price is now in the CTA). Net cut: 4 → 8 questions remain. Brand voice survives; scroll fatigue dies. (`FAQSection.tsx:7-56`)
- **FeatureGrid verticals: 8 → 6.** Cut: "experiential retail" (overlaps signage), "worship" (low TAM, sentimentally tempting but data-poor). Keep theme parks, digital signage, museums, live events, corporate AV, virtual production. (`FeatureGrid.tsx:22-63`)
- **ValuePropSection second paragraph** (`ValuePropSection.tsx:139-143`) — the rotator already says "monitor / deploy / control all of your computers." Saying it again under the dashboard is dead weight. Keep only the one-line headline.
- **Pricing card middle row** (`PricingSection.tsx:61-63`) — `everything included — no feature limits` is implied by the bullet list two divs above. Cut it; the section gets visually tighter.
- **Header `download` button** (`LandingHeader.tsx:30-32`) — moves into the post-signup flow. Pre-signup downloads are a security and support nightmare and the install flow assumes you've paired. Replace with `api` linking to the API reference page.

## 9. what i'd test

1. **Hero CTA copy: `get started — free during beta` vs `start free trial` vs current `get started`.** Hypothesis: explicit price-in-button raises CTR by 8-15% because it kills the "is this expensive" hesitation immediately. Measure CTR on the primary CTA. Two-week test, 50/33/17 split.
2. **Display section presence (above-fold-ish, section 4) vs absent.** Hypothesis: AV-specialist conversion (proxied by users who self-tag a site as "projector wall" or apply a display layout in week 1) lifts 25%+. Also a guard test — measure operator-persona conversion to make sure the display section doesn't *cost* us conversions from the existing audience.
3. **Developer section format: code-tabs vs single hero curl example vs cut entirely.** Hypothesis: code tabs win on time-on-page and on the proxy metric of "first API key generated within 7 days of signup." If the cut variant matches the tabs variant on conversion, kill the section — that means the developer audience just doesn't land here organically.

## 10. risks

**Risk 1: the page is now too long for the operator.** The original page is 7 sections; mine is 8. Adding the display section and the developer section, even after cutting 2 verticals + a paragraph + an FAQ row, means more scroll. If early metrics show operator conversion *down* and AV/dev conversion not yet up (because SEO and word-of-mouth take a quarter to follow new positioning), I look wrong. **Mitigation:** the developer section is a candidate for collapsing into a single banner with three icon-chips, recovering ~70% of the page height, if test #3 goes flat.

**Risk 2: the display section over-promises.** The watchdog and the atomic apply are real (`web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:1-22`), but the marketing diagram suggests perfect reliability. If a real customer hits a Mosaic edge case in week 1, the gap between landing-page promise and product feels big. **Mitigation:** under the diagram, add a real-world caveat in the same dry voice: *"works on every nvidia mosaic config we've tested. found one we haven't? open an issue and we'll add it."* That tone matches the existing FAQ voice and inoculates against the bait-and-switch read.

**Risk 3: the developer section converts the wrong people.** Posting `curl` examples can attract ops engineers who want to embed owlette and then realise it's Windows-only — which is a worse bounce than the marketing-copy bounce. **Mitigation:** the under-CTA strip (`windows only · free during beta · ...`) does heavy lifting here; if metrics show high `/register` → `/dashboard` → never-paired drop-off after the dev section ships, add the words "for windows" to the developer section subhead too.

**Risk 4: trimming FAQs from 12 to 8 weakens the brand voice.** The FAQ is the funniest part of the page (`FAQSection.tsx:38-39`, the kiosk koan, is genuinely good copy) and brand voice is part of why people choose this over a sterile enterprise tool. **Mitigation:** keep the SpongeBob/mayonnaise question (it's the load-bearing weirdness signal); only cut questions that are duplicative. If qualitative feedback says the page feels colder, restore one of the koans.

**Where I disagree with the brief:** the brief implies developers and AV specialists are equal new personas. They are not. The AV specialist is the higher-value bet because (a) they buy more machines per logo, (b) they have a sharper, named pain (black screen during showtime), and (c) the display capability is genuinely unique in the category, while a clean REST API is merely well-executed. So I weight the page accordingly: display gets a full section, the developer story gets a full section, but display sits closer to the dashboard hero shot and gets one more piece of real estate (the diagram). If the brief author's instinct is the opposite — that the developer audience is the bigger unlock — flip sections 4 and 5 and re-test. The structure supports either reading; the bet is which one converts faster.
