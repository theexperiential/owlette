# claude-2 — owlette landing page redesign

## 1. Audience read

In 2026, four distinct people land on `owlette.app`. Ranked by likely conversion value:

1. **AV / show-control specialists** running multi-display installations — projector walls, LED arrays, mosaic stages, museum kiosks. They are the highest-intent visitors because the **display topology + auto-revert** capability has no real competitor at this price. They came from a Reddit thread, an integrator forum, or a vendor recommendation. They will pay $10/machine/month without flinching if the page proves we won't strand a kiosk.
2. **Operators** running theme parks / signage / live events / worship / corporate AV. The current page's primary persona, still real. They convert if we prove auto-recovery works and the dashboard is sane. Volume here is highest, ARPU is medium.
3. **Developers / platform engineers** evaluating us as a building block — embedding fleet control into a CI pipeline, an internal SRE tool, an integrator's commissioning script. They convert on **API quality**, not marketing. Lower volume, but each one drags an org behind them.
4. **Hobbyists / single-machine users** — one TouchDesigner rig at home, a streaming PC. Low ARPU, but they become evangelists and the AGPL self-host path is theirs.

The page today only really speaks to (2). I want it to handshake (1) and (3) within the first three scrolls without alienating (2).

## 2. The wedge

**Owlette is the only operator-grade, cloud-native fleet manager that treats display topology as a first-class, recoverable resource — and exposes everything (processes, deploys, displays, machines) through a real REST API and TypeScript SDK that ops teams can script.** Hand-rolled scripts can restart a process; they can't atomically apply a Mosaic layout with a watchdog that auto-reverts on no-ack. Enterprise signage CMS (Userful, Scala, BrightSign Network) can push content; they can't be automated from a CI job by a developer who doesn't want to fill out a sales form. RMM tools (Atera, NinjaOne) can monitor a process; they don't speak TouchDesigner, GPU temps, or Mosaic. **We sit in the seam where the show-control people, the SRE people, and the operator are the same exhausted human at 2am.** Every section of the page should reinforce that seam.

## 3. Page structure

Order, top to bottom:

1. **`LandingHeader`** *(keep, modify)* — purpose: nav + auth. Earns scroll: it's the chrome. Add a `for developers` link pointing at the dev section anchor (`/#developers`), and demote `download` to a footer item — most visitors should sign up first, install second.
2. **`HeroSection`** *(keep, modify)* — animated owl eye, headline `attention is all you need`, rotating-words sentence, CTAs. Earns scroll: brand promise + emotion in <1s. Modify the suffix-words list to include *projector walls* and *video walls* (display vertical), and add a tiny third tagline pill below the CTAs reading `windows-only · free during beta · self-host on AGPL` so the three deal-breaker facts surface above the fold without a full bar.
3. **`ValuePropSection`** *(keep, lightly modify)* — the 3D-tilt dashboard screenshot + `one dashboard for every screen, every machine, everywhere.` Earns scroll: shows the product is real. Keep the LCP image. Modify the subheadline to land the wedge: see §4.
4. **`UseCaseSection` → renamed `capabilities`** *(modify)* — the 4-card grid of monitor / control / deploy / converse. Earns scroll: this is where most visitors decide if owlette does what they need. Add a fifth card — **display** — promoted in from the wedge. See §5.
5. **NEW: `DisplayDeepDive`** — single-section anchor for AV/show-control. Earns scroll: it's our most-defensible feature and the current page hides it. See §7.
6. **NEW: `DeveloperStory`** *(id `#developers`)* — API + CLI + SDK with one real code sample and one real `curl`. Earns scroll: developers won't trust marketing copy alone, and the snippet is qualifying for them. See §6.
7. **`FeatureGrid`** *(keep, compress)* — verticals strip (`built for theme parks / digital signage / …`). Earns scroll: pattern-match for niche operators ("oh, they know my world"). Keep as the inline word-list it currently is — small, fast, charming. Move it AFTER capabilities/dev/display so it functions as social-proof-by-domain rather than a cold open. Cut `experiential retail` to keep it to seven and add `projector walls & video walls` as the eighth — pulls the AV persona in.
8. **NEW: `ProofStrip`** — one-line trust band. Three columns: `~10s auto-recovery`, `runs offline, syncs when back`, `outbound 443 only — no vpn, no inbound ports`. Pulled directly from the FAQ answers at `web/components/landing/FAQSection.tsx:22-30`. Earns scroll: kills the three most common objections (latency, network, security) before pricing in 12 words.
9. **`PricingSection`** *(keep)* — single tier, free during beta, $10/machine/month. Earns scroll: nothing converts faster than "free during beta + everything included". Tweak the included list; see §5.
10. **`FAQSection`** *(keep, prune)* — 12→8 questions, see §8.
11. **`LandingFooter`** *(keep)* — chrome.

Eleven sections. Seven of them already exist in some form, three are new (display deep-dive, developer story, proof strip), one is renamed. No section earns its scroll just because it's there — every section maps to a persona × decision moment.

## 4. Hero copy

- **Headline:** `attention is all you need` *(keep — non-negotiable brand line, earned at `web/components/landing/HeroSection.tsx:46-48`)*
- **Subheadline (rotating):** keep the prefix/suffix rotation at `HeroSection.tsx:9-20`, but expand the suffix list to: `computers · media servers · interactive installations · interactive exhibits · kiosks · digital signage · projector walls · video walls · TouchDesigner PCs · Unreal Engine nodes · Node.js servers`. Two new entries pull in the AV persona without bloating.
- **Primary CTA:** `get started — free during beta` *(replaces bare `get started`; the qualifier kills sign-up hesitation)*
- **Secondary CTA:** `see the live demo` *(replaces `sign in`; sign-in already lives in the header at `LandingHeader.tsx:33-35`. The demo link at `web/components/landing/ValuePropSection.tsx:124-130` is the strongest second click — surface it at the hero level)*
- **Tertiary microcopy line under CTAs (new):** `windows · free during beta · self-host on agpl` — three pills, lowercase. Says the deal-breakers up front so we don't waste a Mac user's scroll.

## 5. Capability section

Ten capabilities collapse cleanly into **5 first-class cards** + **1 trust strip**. The current 4-card grid at `web/components/landing/UseCaseSection.tsx:7-36` becomes 5, and the strip absorbs three of the remaining facts.

The five cards (label + one-sentence tagline):

- **monitor** — `live cpu, memory, gpu, and disk for every machine, with email and webhook alerts when something drifts.`
- **control** — `start, stop, or restart any process across your fleet in one click — or one api call.`
- **deploy** — `push software, configs, and project files to one machine or a thousand. atomic, rollback-safe.` *(roost lives inside this card per the brief's constraint — mentioned in the expanded copy, never in the headline)*
- **display** — `apply windows display layouts and nvidia mosaic configs atomically. if a kiosk doesn't ack, owlette reverts before the doors open.` *(NEW — promoted out of obscurity. This is the wedge.)*
- **converse** — `talk to your fleet in plain english with cortex. bring your own openai or anthropic key.`

What gets cut from cards / surfaced elsewhere:

- **Public REST API + CLI + SDK** → its own section (§6), not a card. A card would dilute it.
- **Multi-site org + roles** → bullet on the pricing card (already lives at `web/components/landing/PricingSection.tsx:11`).
- **Pairing UX (3-word phrases)** → a 1-line gif/inline demo inside the `deploy` expanded copy. It's a delight detail, not a hero feature.
- **Offline survival** → ProofStrip (§3, item 8). Currently buried in `FAQSection.tsx:22`.
- **Auto-recovery latency** → ProofStrip. Currently at `FAQSection.tsx:30`.

Pricing's `included` list at `PricingSection.tsx:5-15` should also gain `public REST API & SDK` and `display topology with auto-revert` so the pricing-only skimmer sees them.

## 6. Developer story

**Section name:** `script your fleet` (anchor `#developers`)
**Placement:** between `DisplayDeepDive` (§7) and `FeatureGrid`. Reasoning: developers who scroll past the visual product (hero/valueprop/capabilities/display) are now ready to see code. Putting it earlier risks losing the operator persona who doesn't care.
**Headline:** `every screen has an api now.`
**Subheadline:** `owlette ships a public rest api, a typescript sdk, and a cli. scoped keys, idempotency, webhooks, openapi spec — wire your fleet into ci, incident response, or whatever weird internal tool you've already built.`

**Layout:** two columns on desktop, stacked on mobile. Left column is a tabbed code block (3 tabs: `cli`, `typescript`, `curl`). Right column is three small feature blocks: `scoped keys`, `idempotency-key on every write`, `webhooks with hmac sigs`.

**Tabbed code samples** (real, not invented — pulled from the actual route at `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:43-60`):

```bash
# cli
$ npm i -g @owlette/cli
$ owlette login
$ owlette displays apply --site main-stage --machine kiosk-3 --layout mosaic-2x2
```

```ts
// typescript sdk
import { Owlette } from "owlette-sdk";
const o = new Owlette({ apiKey: process.env.OWLETTE_KEY });
await o.displays.apply({
  siteId: "main-stage",
  machineId: "kiosk-3",
  layout: "mosaic-2x2",
}, { idempotencyKey: crypto.randomUUID() });
```

```bash
# curl
curl -X PUT https://owlette.app/api/sites/main-stage/machines/kiosk-3/display-layout \
  -H "x-api-key: $OWLETTE_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"op":"capture","monitors":[...]}'
```

Below the tabs, a single CTA: `read the api reference →` linking to `/docs/api` (the route exists at `web/app/docs/api/route.ts`).

I am NOT killing this as a dedicated section. The brief asks if I would weave it elsewhere — I wouldn't. Developers are pattern-trained: they scroll until they see code, and if there's no code section they bounce to GitHub or Postman. A weaving strategy (a code-tab on a card) loses to a section because it doesn't telegraph "we take this seriously".

## 7. Display management story

**Section name:** `displays that don't strand themselves`
**Placement:** immediately after the capabilities grid (§5). Reason: the `display` card teases it — readers who clicked it want more, and we have an unfair-advantage story to tell.
**Headline:** `applied atomically. reverted automatically.`
**Subheadline:** `set resolution, orientation, primary, multi-monitor layout, and nvidia mosaic from the dashboard or the api. owlette captures the working state, applies the new one, and waits for an ack. no ack, no problem — the agent rolls back before anyone notices.`

**Visual:** a three-frame storyboard (no video — keeps the page light). Frame 1: dashboard "apply mosaic 2×2" button. Frame 2: agent applying with a 30s countdown. Frame 3: green check OR an auto-rollback toast. Static PNGs (or one CSS-animated SVG). Total weight ≤ 80kb.

**Three short bullets under the storyboard:**
- `mosaic-aware` — read and apply nvidia mosaic configs, not just per-monitor settings.
- `watchdog auto-revert` — agent rolls back if no ack within the heartbeat window. mistyping a layout cannot brick a kiosk.
- `via api or dashboard` — every layout op is a `PUT /api/sites/{id}/machines/{id}/display-layout` call (see `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:1-21`).

Why a dedicated section: the brief calls display management *the deciding feature* for AV specialists. Half a card won't convert that persona — they need to see the safety story (atomic + auto-revert) explicitly. This is the most defensible piece of the product and currently 0% of the landing page.

## 8. Cuts

- **FAQ: `is mayonnaise an instrument?`** at `web/components/landing/FAQSection.tsx:48-50` — cut. The Spongebob joke is fine in a Discord bio; on a page that wants to convert a $50k/yr signage ops lead it reads as unserious. Keep the dry voice elsewhere (the Mac/Linux "loudly. in the middle of a show." quip at `FAQSection.tsx:18` stays — it's punchier and contains real info).
- **FAQ: `if a kiosk crashes and nobody's there to see it…`** at `FAQSection.tsx:36-38` — cut. Cute, but redundant with the auto-recovery answer.
- **FAQ: data security answer** at `FAQSection.tsx:42` — keep the content, cut the `all your base` callback. Buyers in compliance-adjacent verticals (museums, theme parks) skim this answer for due diligence and the meme breaks the spell.
- **FAQ: self-host answer** at `FAQSection.tsx:53-54` — compress. The "neighbor's camper / furnace at -10°" riff is great but 4× longer than it needs to be. Cut to: `yes — owlette is agpl-3.0, full source on github. requires firebase + railway (or equivalent). hosted version exists for a reason.`
- **Verticals list: `experiential retail`** at `web/components/landing/FeatureGrid.tsx:59-62` — cut, replace with `projector walls & video walls`. Retail is a sub-case of signage; AV is a missing persona.
- **`download` link in the header** at `LandingHeader.tsx:31-33` — demote to footer. Almost no first-time visitor should be downloading the agent before signing up — they'll hit the pairing flow and get confused. Sign-up first, install second.
- **Hero animated eye** — keep, but verify on mobile that `InteractiveBackground` at `HeroSection.tsx:5,26` doesn't tank LCP on cheap Android. If it does, gate it behind a `prefers-reduced-motion` check and serve a static gradient otherwise.

Net: page becomes shorter on text, longer on signal.

## 9. What I'd test

1. **Hero CTA copy A/B** — `get started — free during beta` vs current `get started`. Hypothesis: the qualifier lifts sign-up rate by ≥10% because it kills credit-card-fear without the user reading the pricing section. Easy test, real money on the line. Run for two weeks, segment by referrer.
2. **Display-deep-dive presence A/B** — page-with vs page-without the §7 section. Hypothesis: AV/show-control referrers (UTM-tagged from forum/Reddit links, plus heuristic on session duration on the section) convert 2–3× higher with it. If true, double down with a second wedge feature in v2; if not, fold it into a card and reclaim 600px of scroll.
3. **Qualitative — 5-second test on the new hero** — show the new hero (with the third tagline pill `windows · free during beta · self-host on agpl`) to 20 people unfamiliar with the product. Ask: *what does this do? who is it for?* If <60% identify "Windows fleet management" or equivalent, the rotating-words sentence is doing too much work and we need a static one-line subhead under the headline.

I'd skip a pricing-position test for now — the single-tier "free during beta" message is already as strong as that page can be without product changes.

## 10. Risks

- **Risk: the new page is more text-heavy and could hurt the operator persona's emotional first impression.** The current page's strength is that the hero + tilted-screenshot combo at `web/app/page.tsx:51-53` is genuinely beautiful and creates trust before any reading happens. Adding a developer code section and a display storyboard adds cognitive load. If post-launch session recordings show operators bouncing earlier than before, I'd reorder: move `DeveloperStory` (§6) below `FeatureGrid` so the operator-only path stays clean and the developer path requires one extra scroll.
- **Risk: the display deep-dive is over-indexed on a feature that the brief calls "in flight" or under-tested.** From the agent code path at `agent/src/display_manager.py` and the API contract at `display-layout/route.ts`, the watchdog auto-revert is real — but if production reliability is shaky for the first 90 days post-launch, marketing the safety story will create support tickets I can't pay back. Mitigation: gate the §7 storyboard's third frame ("auto-rollback") behind a small `with auto-revert in beta` chip, and document the heartbeat window publicly. Honesty preserves the wedge; pretending it's bulletproof breaks it the first time it fails.
- **Risk: the third hero tagline pill (`windows · free during beta · self-host on agpl`) clutters the brand-pure hero.** The current hero's restraint is part of why the product reads as premium. If the pill makes the hero feel like a SaaS landing-page checklist, kill it and move those three facts into the ProofStrip (§3, item 8) instead.
- **Risk: I'm wrong about the audience priority.** I ranked AV/show-control above operators. If the actual conversion data after launch shows operators are 4× more common and AV is rounding-error, I rebalance — but the cost of being wrong is just demoting the §7 section, not rebuilding the page. The wedge ("operator-friendly + cloud-native + AI + extensible API + display-aware") survives either ranking.

---

**Total architecture change:** keep the brand and the bones, surface the two missing personas (developer, AV specialist) with one section each, prune one cute FAQ and one dead vertical, and let the existing capability grid carry slightly more weight by adding the display card. The page goes from "we monitor your computers, also AI" to "we run your fleet — every process, every screen, every api call — and we will not strand your kiosk."
