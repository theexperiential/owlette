# Landing-page screenshot generation

Auto-generated PNGs for the landing page, captured from real product UI via Playwright
against Firebase emulators. The output is byte-identical across runs so we can commit
the images and review changes as diffs.

## Prerequisites

Same baseline as the main E2E suite:

| Dependency | Version | Why |
|---|---|---|
| JDK 21 | exact pin | Firestore emulator requires JVM |
| firebase-tools | 13.x | `npm i -g firebase-tools@13` |
| Playwright | managed by `npm ci` | `npx playwright install chromium --with-deps` once |

## Running locally

```bash
cd web
npm run screenshots
```

Output PNGs land in `web/public/landing-screens/`. The landing components reference
these paths directly, so the next `npm run dev` picks them up automatically.

## Output location

| Path | Used by |
|---|---|
| `web/public/landing-screens/dashboard.png` | `components/landing/ValuePropSection.tsx` |
| `web/public/landing-screens/monitor.png` | `components/landing/UseCaseSection.tsx` (monitor card) |
| `web/public/landing-screens/control.png` | `UseCaseSection.tsx` (control card) |
| `web/public/landing-screens/preview-deploy.png` | `UseCaseSection.tsx` (deploy card) |
| `web/public/landing-screens/preview-diagnose.png` | `UseCaseSection.tsx` (diagnose card) |
| `web/public/landing-screens/preview-displays.png` | `UseCaseSection.tsx` (display card) |
| `web/public/landing-screens/preview-automate.png` | `UseCaseSection.tsx` (automate card) |

## Adding a new screenshot

1. Add the new scenario name to the `ScreenshotScenario` union in `fixtures.ts`, then
   write a seed function that populates the emulator with the state you want captured.
2. Add a spec at `web/e2e/screenshots/{name}.spec.ts` that consumes the scenario via
   the fixture helper and saves to `web/public/landing-screens/{name}.png`.
3. Reference the new file in the relevant landing component (e.g. add a new entry to
   the `capabilities` array in `UseCaseSection.tsx`).

## Debugging

```bash
cd web && npm run screenshots:debug
```

Runs the suite headed with Playwright Inspector attached. Traces and per-test artifacts
land in `web/e2e/.output/screenshots-results/` for postmortem analysis.

## Determinism

Screenshots must be byte-identical across runs so PRs show meaningful diffs. The fixture
helper enforces this by:

- Anchoring all timestamps to `FIXED_NOW_MS` (2026-04-15) so "5m ago" / "2h ago" labels
  resolve to the same string every run.
- Seeding deterministic PRNGs for any synthetic metric series.
- Disabling CSS animations and transitions before capture.
- Pinning `page.clock` to `FIXED_NOW_MS` so client-side `Date.now()` matches the seeded
  data.

If a screenshot starts diffing on every run, the first thing to check is whether new UI
introduced an un-anchored time source (`new Date()`, `performance.now()`) or an
animation that hasn't settled by the capture frame.
