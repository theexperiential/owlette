# Tutorial web-capture harness

Drives the dashboard at 1080p against the seeded demo fleet and records one `.webm`
per scene — the web-footage half of the tutorial pipeline (the other halves are
ElevenLabs voiceover and pywinauto native capture; see `dev/video-tutorials/`).

This is a **sibling of the screenshots harness** (`../screenshots/`). It reuses the
same emulator boot, `global-setup` (role fixtures), `webServer`, and — crucially — the
same deterministic demo data (`../screenshots/fixtures.ts`: a 10-machine AV/signage
fleet, Cortex chats, roost rollouts, schedule presets).

> **Status:** this harness currently ships **one worked example scene** — episode 3
> (dashboard tour), beats b01–b04 (`dashboard-tour.video.ts`). The scenario→episode
> table below is the **target map**; the remaining scenes are built by copying the
> example.

## Run

```bash
cd web
npm run videos                       # the implemented example scene(s)
npm run videos -- --grep "dashboard" # one scene (grep matches the test title)
npm run videos:debug                 # headed + inspector, to tune selectors/pacing
```

Prereqs are identical to the E2E suite (JDK 21, firebase-tools 13, chromium installed).
Output: `web/e2e/.output/videos/<scene>.webm`.

## How a scene works

```ts
test('episode N — title', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states'); // pick a scenario
  try {
    await getAdminDb().collection('users').doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });          // auto-select the site
    await recordScene(browser, 'NN-slug', { baseURL: E2E_BASE_URL,
      storageState: roleState('admin').storageState }, async (page) => {
        await openForCapture(page, '/dashboard');                 // goto + settle
        await narrate(page, 'b01 ...', 6);                        // dwell ~6s for the beat
        await clickWithCursor(page, page.getByTestId('view-toggle-list'));
        await narrate(page, 'b02 ...', 8);
      });
  } finally {
    await ctx.cleanup();
  }
});
```

- File names end in `.video.ts` (the config's `testMatch`).
- Each scene records its OWN context (`recordScene`) so the `.webm` is named after the
  episode, not Playwright's auto hash.
- `narrate(page, beat, seconds)` is a dwell sized to that beat's voiceover length — it's
  what keeps the screen on a frame long enough to lay the MP3 underneath.
- `installFakeCursor` (called by `recordScene`) draws a visible pointer + click ripple;
  headless Chromium has no OS cursor, so without it clicks look like nothing happened.

## Why `recordVideo`, not OBS, for web

Built-in `recordVideo` at an explicit 1920×1080 (not the downscaled 800×800 default) is
turnkey and repeatable — no human in the loop, regenerates whenever the UI changes. The
frame rate is screencast-variable (fine for UI demos). If you ever want buttery 60fps
for a hero moment, run `npm run videos:debug` (headed) and capture that window in OBS
instead; the scene code is identical.

## Determinism

Inherited from the screenshots harness: fixed clock (`FIXED_NOW_MS`), disabled CSS
animations, seeded PRNG sparklines, fixed machine ids. See `../screenshots/README.md`.

## Target scenario → episode map

_Only the dashboard-tour example (ep3, b01–b04) is implemented today; the rest is the build plan._

| Scenario (fixtures.ts) | Episode |
|---|---|
| `dashboard-mixed-states` | 1 (b-roll), 3 (dashboard), 7 (remote actions) |
| `monitor-single-machine` | 6 (machine health) |
| `control-process-restarting` | 4 (keep alive), 13 (logs) |
| `automate-schedule-editor` | 5 (schedule), 11 (alerts) |
| `deploy-roost-rolling` | 9 (deploy), 10 (roost) |
| `diagnose-cortex-chat` | 12 (cortex) |
| `display-layout-editor` | optional display add-on |
