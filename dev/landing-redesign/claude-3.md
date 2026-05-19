# landing redesign — claude-3

## 1. audience read

three personas land on owlette.app in 2026, ranked by likely conversion value:

1. **the show-control / AV operator** (highest LTV, fastest close). they run a museum, theme-park ride, signage network, megachurch, XR stage, or experiential retail flagship. budget authority is local, decisions are fast, the pain is concrete: a kiosk crashed at 3am, a projector wall went black mid-show. they convert on a single screenshot of the dashboard plus a believable pricing line. the current page is built for them and that's correct — but they're underserved on the display-topology story, which is now their biggest unmet pain.

2. **the AV/show-control engineer with a mosaic / projector wall problem** (highest conversion intent, smallest pool). a sub-segment of (1) but worth calling out separately, because they arrive having already lost a Saturday rebuilding NVIDIA Mosaic by hand. for them, "atomic apply with watchdog auto-revert" is not a feature — it's the entire reason they sign up. they need to see the words "mosaic" and "auto-revert" above the fold of a section, not buried in a card.

3. **the platform / devops engineer at a larger ops team** (slowest close, highest expansion revenue). they manage 50–500 windows boxes for a brand or systems integrator. they want REST, CLI, SDK, webhooks, scoped keys, idempotency, OpenAPI. they're sceptical of marketing copy and bounce if they don't see code in the first viewport of the developer section. this persona didn't exist on the landing page when it was written. they're now a real conversion path for accounts of 20+ machines.

linux/mac visitors are pure bounce — say windows-only above the fold, full stop. don't waste them or us.

## 2. the wedge

owlette is the only fleet-control tool that an operator can install in an afternoon, a developer can script against in an hour, and an AV engineer can trust to never strand a projector wall on a black screen. enterprise signage CMS (Userful, Scala, BrightSign) wins on polish and loses on price, lock-in, and developer surface. RMM tools (NinjaOne, ConnectWise) win on IT breadth and lose on creative-tech context — they don't speak TouchDesigner, Mosaic, or Unreal nodes. hand-rolled scripts win on cost and lose on everything else the moment a fleet crosses 10 machines. owlette's one sentence: **the cloud-native fleet console for windows machines that run things on screens — with a real API, a real CLI, and a watchdog that won't let your display config kill the show.** every section below earns its place by reinforcing "operator-friendly + extensible + show-safe."

## 3. page structure

target: 9 sections. cuts described in §8.

1. **landing header** (keep, modify). add `api` and `cli` links between `pricing` and `docs`. these are the two surfaces a developer looks for first. evidence: `web/components/landing/LandingHeader.tsx:24-34` currently has only `pricing / docs / download / sign in / get started`.
2. **hero** (keep, modify copy below). still center-anchored eye + rotating words, still `attention is all you need`. add a one-line platform pill underneath the eye so windows-only is unmissable. why earn scroll: it's the brand moment and sets voice in 2 seconds. on screen: `OwletteEye`, headline, rotating subhead, pill, two CTAs.
3. **value-prop dashboard tilt** (keep). 3D-tilt screenshot of `/dashboard.png`, headline `one dashboard for every screen, every machine, everywhere.` why earn scroll: it shows the product is real, not a landing page for vapor. evidence: `web/components/landing/ValuePropSection.tsx:105-112` — keep the LCP image priority, no changes to perf profile.
4. **what owlette does** (modify — was `UseCaseSection`). expand from 4 cards (monitor / control / deploy / converse) to 6 (add `displays` and `automate`). atomic-apply preview becomes the new headline screenshot. why earn scroll: the operator persona converts here. on screen: 6-card grid → click expands a real product screenshot. evidence: current 4-card grid at `web/components/landing/UseCaseSection.tsx:7-36`.
5. **displays — atomic apply + auto-revert** (new). dedicated section because mosaic / multi-monitor is the deciding feature for persona 2 and there is no competitor doing it. why earn scroll: it's the wedge nobody else has. on screen: short looped diagram (svg, not video) of "send layout → ack → if no ack in 30s, revert," plus a screenshot of the display-layout panel.
6. **for developers — api, cli, sdk** (new). headline + 3 working code samples (curl, `@owlette/cli`, `@owlette/sdk`) showing the same operation. why earn scroll: the platform-engineer persona bounces without it. on screen: tabbed code block + a one-line link to the interactive api reference. evidence for shape: real routes already exist at `web/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/restart/route.ts` and friends.
7. **built for** (keep, compress). the verticals row from `web/components/landing/FeatureGrid.tsx:22-63`. shrink hover taglines, keep the scannable list. why earn scroll: it's the "yes, you, specifically" beat for the operator. cheap, fast, well-loved.
8. **pricing** (keep, light edit). free during beta, $10/machine/month. add a one-line for the agpl self-host option which is currently buried in FAQ. why earn scroll: pricing is the second most-clicked nav link; people skip to it.
9. **questions, answered** (modify — was `FAQSection`). cut from 12 to 7. keep the voice. why earn scroll: it answers objections on the way to the CTA. evidence: current 12 at `web/components/landing/FAQSection.tsx:7-56`.

removed: nothing structural — but a *section* of cuts within sections is in §8.

## 4. hero copy

keep `attention is all you need` — it is the brand and a smart riff. but the current rotating subhead (`web/components/landing/HeroSection.tsx:9-20`) tries to say everything by listing every workload. it should instead say one thing clearly. the rotating verbs were great when the product was just monitoring; now they obscure the wedge.

- **headline:** `attention is all you need`
- **subheadline:** `monitor, deploy, and remotely control the windows machines that run your screens — with a watchdog that won't let a bad config strand the show.`
- **platform pill** (new, sits under subheadline, before CTAs): `windows only · free during beta · agpl self-host`
- **primary CTA:** `get started` (unchanged — `HeroSection.tsx:62`)
- **secondary CTA:** `see the live demo` (replaces `sign in`, which already lives in the header at `LandingHeader.tsx:34`. don't double-up. demo link is more useful for a cold visitor than a sign-in repeat.)

i'd keep a *single* rotating word — the suffix. drop the prefix rotation. the verbs are now stable in the subhead. so subhead becomes: `monitor, deploy, and remotely control the windows machines that run your <RotatingWord> — with a watchdog that won't let a bad config strand the show.` rotating values: `kiosks · digital signage · projector walls · touchdesigner pcs · unreal nodes · live shows · museum exhibits · theme park rides`. one rotation is rhythmic; two is busy.

## 5. capability section

ten capabilities, six cards. group + cut:

- merge `process monitoring & auto-recovery` (1) + `remote control` (2) → one card `monitor & control` — the user thinks of these as one thing.
- promote `display topology` (7) to its own card — it was buried; it's the wedge.
- merge `software deployment` (3) + `roost` mention into one card `deploy` — mention roost as one sentence, not the headline (per brief).
- keep `cortex` (4) as `converse`.
- promote `api + cli + sdk` (5+6) into one card `extend` — operators understand it as "build on top of it."
- new card `automate` = scheduled reboots, startup sequences, dependency-aware restarts. these exist, they sell themselves to ops, and they're not on the page today.
- `multi-site / RBAC` (8), `pairing UX` (9), `offline survival` (10) become one-liners under their relevant cards instead of standalone tiles — they are reassurances, not reasons to sign up.

final card set (label · one-sentence tagline):

- **monitor & control** · live cpu / memory / gpu / disk for every machine, with one-click start, stop, and restart across the fleet.
- **displays** · capture and apply windows display topologies (including nvidia mosaic) atomically — with a watchdog that auto-reverts a bad layout before anyone sees a black screen.
- **deploy** · push installers, configs, and project files to one machine or a thousand — with atomic deploy and rollback via roost.
- **converse** · ask cortex in plain english: "restart the media server on node 3," "what crashed at 3am" — bring your own openai or anthropic key.
- **extend** · scoped api keys, webhooks, idempotency, openapi spec, `@owlette/cli`, `@owlette/sdk` — script your fleet from a terminal or a backend.
- **automate** · scheduled reboots, startup sequences, dependency-aware restarts — set the rules once and stop babysitting.

reassurance line under the grid (not a card, just text): `agents survive offline, recover locally, and sync when the cloud comes back. enrol any machine with a 3-word phrase — no browser login on the target.`

## 6. developer story

a dedicated section, not woven elsewhere. weaving it loses persona 3 because they scan for code blocks; if they don't see one they assume there isn't an api. evidence that the api is real and worth showing: `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:1-21` documents capability scopes, idempotency keys, and discriminated `op` bodies. that file alone is a proof-of-quality.

placement: section 6, immediately after `displays`. the story flows operator → wedge → developer → verticals. devs see displays, think "ok, but i need to drive this from my CI," and the next section answers exactly that.

headline: `script your fleet. or don't.`

subhead: `every dashboard action is a documented rest endpoint. scoped keys, idempotency, webhooks, openapi. install the cli on a runner, import the sdk into your backend, or just curl it.`

three tabbed code samples on the same operation — restart a process. real, working, copy-pasteable:

```bash
# curl
curl -X POST https://owlette.app/api/sites/$SITE/machines/$MACHINE/processes/$PROC/restart \
  -H "x-api-key: $OWLETTE_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```bash
# @owlette/cli
owlette process restart $PROC --machine $MACHINE --site $SITE
```

```ts
// @owlette/sdk
import { Owlette } from '@owlette/sdk';
const owl = new Owlette({ apiKey: process.env.OWLETTE_KEY });
await owl.processes.restart({ siteId, machineId, processId });
```

below the code block, three reassurance bullets in small text:

- `keys are scoped per-site and per-action — a webhook delivery key cannot restart a machine.`
- `idempotency-key is enforced server-side. retry safely.`
- `interactive api reference and openapi spec at /docs/api.`

one trailing CTA: `read the api quickstart →`. links to the existing `web/app/docs/api/route.ts` doc. this section earns its scroll because it answers "is this a toy?" with three lines of code.

## 7. display management story

dedicated section, slot 5, between `what owlette does` and the developer pitch. the story logic: operator sees the dashboard (3) → reads what it does (4) → hits the one feature no competitor has (5) → realises this is also a platform (6).

design: full-width, two-column on desktop, stacked on mobile. left column: short svg animation of a 4-monitor mosaic being captured, then a bad layout being applied, then auto-reverting after a 30-second timeout — three frames, looped, ~80kb. right column: copy.

headline: `the only fleet tool that won't strand your projector wall.`

subhead: `display configs are dangerous. one mistyped resolution and a kiosk goes black at the worst possible moment. owlette captures your good layout, applies new ones atomically, and watches for an ack — if the agent doesn't confirm in 30 seconds, the previous layout is restored automatically.`

three short proof points (lifted from real product behaviour, see `agent/src/display_manager.py` and `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:1-21`):

- `capture once — every monitor's resolution, orientation, primary flag, and mosaic group.`
- `apply atomically — full topology in one transaction, not per-monitor drift.`
- `watchdog auto-revert — no ack from the agent within the timeout, the previous layout returns automatically.`

trailing CTA: `see how display management works →` — links to a docs page (existing or to be added). compensating perf: the svg loop is lighter than the existing intersection-observer-driven `ValuePropSection` raf loop in `web/components/landing/ValuePropSection.tsx:39-86`, so net page weight is roughly flat.

i'd defend this getting more real estate than the developer section. persona 2's mosaic pain is more acute than persona 3's "is the api any good" curiosity, and the wedge here is wider.

## 8. cuts

- **FAQ: 12 → 7.** keep: `is it actually free`, `windows-only`, `what happens if my machine loses internet`, `firewall ports`, `auto-recovery speed`, `cortex`, `self-host`. cut: `will it work with my software` (covered implicitly by examples in capability cards), `data security` (move into a one-liner under pricing or a small trust strip), `site vs machine` (better answered in onboarding, not on landing), `mayonnaise an instrument`, `if a kiosk crashes and nobody's there`. the gag faqs at `web/components/landing/FAQSection.tsx:37-39` and `:48-51` are funny once and a tax on every subsequent visit. one wink, not three. keep `is it actually free` as the wink.
- **vertical list (`FeatureGrid`)**: keep the row, drop the per-vertical hover taglines or shrink to 6 chars. a wall of one-liners reads as desperate; the icons + labels alone do the persona-mirror job in half the space. evidence: `web/components/landing/FeatureGrid.tsx:22-63`.
- **rotating-words prefix** in hero: cut. one rotation, not two. justified in §4.
- **footer emoji random**: keep — it's cheap charm and runs server-side already (`web/components/landing/LandingFooter.tsx:21`).
- **`download` link in header**: keep but de-emphasise. agents are installed by operators, not visitors who haven't signed up. it can be one rank lower in visual weight.

net: page is shorter and denser, not longer, despite adding two sections. displays and developer sections replace bulk lost from FAQ + vertical taglines + one rotating word.

## 9. what i'd test

three tests, ranked by expected lift:

1. **does the display section convert AV engineers?** A/B the page with displays section in slot 5 vs. displays as a card inside `what owlette does`. measure signup rate filtered to visitors who hover/click the displays card or scroll past the section. hypothesis: dedicated section converts ≥30% better for that segment, ≤5% worse overall — i'll take that trade. instrument with simple section-in-view + click events to plausible analytics; no heavy tooling.

2. **does the developer section earn its scroll, or does it scare operators?** A/B the page with the developer section visible vs. collapsed behind a "for developers →" link. hypothesis: visible converts platform engineers without hurting operators because the code blocks are tabbed and skimmable. measure: signup conversion split by a self-reported role on the registration page (a one-question dropdown — already easy to add). worst case: collapse it behind a link and put a single line in the capability grid.

3. **does the simplified hero subhead beat the double rotation?** A/B the existing two-rotation subhead vs. the single-rotation suffix-only version. hypothesis: single rotation reads faster, increases scroll-past rate to `ValuePropSection` (the LCP and the conversion engine). measure scroll-depth + CTA click-through.

i would not A/B `attention is all you need` against anything. it's load-bearing brand and the lift would have to be huge to justify rebranding.

## 10. risks

three honest weaknesses:

- **the display section may overrate persona 2.** if metrics show fewer than 5% of signups self-identify as "running projector walls / mosaic," the section is bigger than it deserves. mitigation: shrink it to a card inside `what owlette does` and reclaim the real estate for a `cortex` deep-dive, which has broader cross-persona appeal.

- **the developer section may scare the operator.** code blocks signal "this is for engineers" and a museum tech might bounce. mitigation: lead the section with the line `you don't need to use the api — but it's there if you do.` plus a small visual cue (greyed-out terminal background) to mark it as optional. if A/B test 2 shows operator drop-off, collapse it as described.

- **i'm cutting the gag FAQs and the prefix rotation, both of which have personality.** the current page's voice is part of the brand, and stripping it for clarity could make the page feel more like every other dev tool. mitigation: keep the wink intentionally — `is it actually free` answer, the random footer emoji, and the `windows-only` faq's `your mac is fine — it doesn't need monitoring` line all stay. that's enough voice to keep the page from reading sterile, without three jokes that pay tax on every revisit.

a fourth risk i'm less worried about: page weight. the new svg loop and the tabbed code block are both lighter than the existing `UseCaseSection` lightbox (`web/components/landing/UseCaseSection.tsx:314-406`) and intersection-observer raf in `ValuePropSection`. net delta should be flat or negative.

if early metrics confirm risks 1 or 2, the fix is structural (move sections, don't rewrite copy). if risk 3 fires — the page tests as having lost personality even with the saves above — i'd reintroduce *one* additional gag faq, not three, and run it as an A/B against the current 7-question version. cheap to revert, easy to measure.
