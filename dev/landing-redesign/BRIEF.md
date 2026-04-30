# Landing page redesign brief

## The job

Owlette's marketing landing page (`web/app/page.tsx` and components in `web/components/landing/`) was written when the product was a process monitor + auto-recovery tool with a small AI assistant. Since then, the product has grown major surfaces — a public REST API with scoped keys and webhooks, a command-line interface and TypeScript SDK, and a Windows display-topology manager (projector walls, signage, mosaic) with auto-revert on misconfig. None of these appear on the landing page today.

**Your task:** propose what should be on the landing page (sections, structure, headline copy, key value-prop language) and how it should be arranged so that someone landing on `owlette.app` for the first time becomes convinced to sign up. Think from scratch — you are not patching the existing page, you are deciding what the page should be now that the product is bigger. Your proposal will be compared against five other independent proposals from different AI agents working from the same brief.

## What the product does (full capability inventory)

1. **Process monitoring & auto-recovery** — agent watches Windows processes, reports CPU/memory/GPU/disk metrics in real time, auto-restarts crashes within ~10 seconds, sends email/webhook alerts on threshold breaches.
2. **Remote control** — start/stop/restart any process across any machine in your fleet from the dashboard. Reboot machines. Configure startup sequences and dependencies.
3. **Software deployment** — silent install of software, configs, and content across single machines or entire fleets. Includes the in-flight `roost` system for content-addressed project file distribution with atomic deploy and rollback.
4. **Cortex (AI fleet assistant)** — natural-language interface to your fleet. "Restart the media server on node 3", "what crashed at 3am", "which nvidia driver are we running". Bring-your-own-key (OpenAI / Anthropic / compatible).
5. **Public REST API** — fully scoped API keys (per-site, per-action), idempotency, webhooks, OpenAPI spec, in-app interactive reference. Lets ops teams build owlette into their own tooling, CI pipelines, and incident response flows.
6. **CLI + TypeScript SDK** — `@owlette/cli` and `@owlette/sdk`. Script your fleet from a terminal, npm script, or backend service. Aligned with the Anthropic / Linear / Vercel naming convention (`/sdk`).
7. **Display topology management** — read and apply Windows display configurations (resolution, orientation, primary, multi-monitor layout, NVIDIA Mosaic). Atomic apply with watchdog auto-revert if no acknowledgement — so a mistyped layout cannot strand a kiosk in a black screen. Differentiator: no other process-monitoring tool does this.
8. **Multi-site organization with role-based access** — sites, machines, members, roles. Org-level admin plus per-site collaborators.
9. **Pairing UX** — agents authenticate via 3-word device-code phrases, no browser login on the target. Bulk silent install supported.
10. **Offline survival** — agent monitors and recovers locally even when disconnected; syncs when the cloud returns.

## Who actually buys this (audience inventory)

The landing page today addresses one persona: the operator who runs digital signage / theme park rides / museums / kiosks / live events / virtual production / corporate AV / worship services. That persona is real and stays. But the new surfaces unlock at least two more:

- **Developers / platform engineers** who want to integrate fleet control into their own product or CI/CD. Care about: API quality, SDK ergonomics, webhook semantics, scoped auth, OpenAPI. Sceptical of marketing copy. Want to see code.
- **AV/show-control specialists** managing projector walls, video walls, LED arrays, and complex display topologies. Care about: Mosaic support, atomic apply, rollback safety, predictable behavior across reboots and driver updates. Display management is often the deciding feature for them.

Other audience facts:
- Windows-only. Linux/Mac users bounce immediately — say so up front.
- Free during beta, $10/machine/month after. AGPL-3.0 self-host option.
- Existing competitors are usually expensive enterprise tools (Userful, Userful, Scala, Christie Pandoras Box adjacent, BrightSign Network, etc.) or hand-rolled scripts. Owlette's wedge is "operator-friendly + cloud-native + AI + extensible API".

## Current landing page (so you don't repeat what's there)

`web/app/page.tsx` renders, in order: `LandingHeader`, `HeroSection`, `ValuePropSection`, `UseCaseSection`, `FeatureGrid`, `PricingSection`, `FAQSection`, `LandingFooter`. Read these files before drafting your proposal. Key facts about the current copy:

- **Hero** has a center-anchored animated owl eye, the headline `"attention is all you need"` (riffing on the transformer paper title — keeps), and a rotating-words sentence with prefixes (`monitor / deploy / ask / control / manage`) and suffixes (computers, media servers, interactive installations, kiosks, digital signage, TouchDesigner PCs, Unreal Engine nodes, Node.js servers).
- **ValueProp** is a 3D-tilt dashboard screenshot with the line `"one dashboard for every screen, every machine, everywhere."`
- **UseCase** is a 4-card grid with monitor / control / deploy / converse — each opens an inline preview screenshot with a lightbox.
- **FeatureGrid** is a verticals list (theme parks / digital signage / museums / live events / corporate AV / worship / virtual production / experiential retail).
- **Pricing** is a single tier ("free during beta, $10/machine/month after").
- **FAQ** has 12 questions, mostly tonal (mayonnaise / spongebob jokes mixed with security and self-host answers).
- Voice: lowercase everywhere, dry, slightly self-deprecating, Anthropic/Linear-adjacent.

## Constraints

- Voice is lowercase. Do not propose Title Case copy.
- Keep `"attention is all you need"` as the hero headline (it's the brand). You can change literally anything else, including replacing it if you have a strong reason — but defend the reason.
- The page must still load fast. If you propose a heavy section (video, large interactive widget), say what you'd cut to compensate.
- The page must work on mobile.
- Do not invent capabilities the product does not have. Stick to the inventory above.
- Do not reference roost as a primary section — it's still in flight and shouldn't be the headline; it can be mentioned inside "deploy".

## What to deliver

Write a single markdown document with these sections, in order:

1. **Audience read.** Who you think is landing on this page in 2026, ranked by likely conversion value. 100-200 words.
2. **The wedge.** In one paragraph, what is the single sharpest reason this product wins against the alternatives someone is comparing it to (hand-rolled scripts, enterprise signage CMS, RMM tools, custom in-house dashboards). Use this to anchor every later decision.
3. **Page structure.** An ordered list of sections from top to bottom of the new landing page. For each section: name, one-line purpose, one-line "why this section earns its scroll", and (if visual) what's on screen. 7-12 sections is the sweet spot — fewer feels thin, more feels desperate. State which existing sections you keep, modify, or cut, and where new sections slot in.
4. **Hero copy.** Headline (keep `"attention is all you need"` unless you justify replacing it), subheadline, primary CTA label, secondary CTA label. Exact copy.
5. **Capability section.** How you surface the 10 capabilities above without overcrowding. Group, prioritise, and decide what gets a card / what gets a one-liner / what gets cut. Show your final card set with the exact label and one-sentence tagline for each.
6. **Developer story.** The API + CLI + SDK pitch. What does this section look like, what code samples appear, what's the headline, where does it slot in the page order, and why. If you'd kill this as a dedicated section and weave it elsewhere, defend that.
7. **Display management story.** Same brief as the developer story — section design, copy, visuals, placement.
8. **Cuts.** What currently on the page would you remove or compress, and why. (FAQ answers, vertical list, etc.)
9. **What you'd test.** Two or three concrete A/B or qualitative tests you'd want to run after launch to validate the choices you made.
10. **Risks.** Where you think your proposal is weakest or might not convert as well as the current page, and what you'd do if early metrics confirmed that risk.

**Length:** target 1500-2500 words total. Be specific. Show actual copy, not "compelling headline goes here". Cite the file paths you read from the current codebase as evidence — `web/components/landing/HeroSection.tsx:9` style. If you discover product capabilities I missed in the inventory, name them and slot them in.

**Output:** save your full proposal to `dev/landing-redesign/{your-agent-id}.md` (your prompt will tell you which id to use). Do not modify any other file.
