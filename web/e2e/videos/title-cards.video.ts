/**
 * Title-card renderer — full-screen animated cards for the tutorial series.
 *
 * Two kinds, per rosco's spec (2026-09-01): a MAIN card opening every episode
 * (eye mark + wordmark + episode title, larger and slightly longer) and a
 * SECTION card for each beat boundary (same lockup + the beat's title). Both
 * animate the same way the footage moves: a slow continuous scale-up with a
 * brief fade in and out — the series' push grammar, applied to type.
 *
 * Runs on its own config (title-cards.config.ts): the cards are
 * `page.setContent` documents with the eye SVG inlined and Geist loaded from
 * Google Fonts — no app server, no emulators. Recording reuses the scene
 * recorder (ddagrab+NVENC with fallback) against the fullscreened window.
 *
 * Modes (env):
 *   CARDS=preview  — one main + one section card (ep04) to footage/cards/
 *   CARDS=batch    — every episode: main card + a section card per titled beat
 *
 * Output: dev/video-tutorials/footage/cards/<name>.mp4 at 1920x1080.
 * Durations: main 4.2s, section 2.6s.
 */

import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FfmpegRecorder, planCapturePaths } from './ffmpeg-recorder';

const REPO = path.resolve(__dirname, '..', '..', '..');
const MANIFESTS = path.join(REPO, 'dev', 'video-tutorials', 'assembly', 'manifests');
const OUT_DIR = path.join(REPO, 'dev', 'video-tutorials', 'footage', 'cards');
const EYE_SVG = readFileSync(path.join(__dirname, '..', '..', 'public', 'owlette-eye.svg'), 'utf-8');

const MAIN_SECONDS = 4.2;
const SECTION_SECONDS = 2.6;

interface CardSpec {
  /** Output file name, no extension. */
  name: string;
  kind: 'main' | 'section';
  /** The big heading. */
  heading: string;
  /** Muted eyebrow above the heading (main cards: "episode NN"). */
  eyebrow?: string;
}

function cardHtml(spec: CardSpec): string {
  const isMain = spec.kind === 'main';
  // Everything is authored at 2x and the base transform halves it: the
  // composited layer is rasterized once at double resolution, so the slow
  // scale-up is a GPU downsample every frame - no per-step re-raster, no
  // device-pixel snapping (the first preview "stepped like stairs": rosco).
  const eye = (isMain ? 168 : 128) * 2;
  const wordmark = (isMain ? 54 : 42) * 2;
  const heading = (isMain ? 96 : 72) * 2;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600;650&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden;
    background: oklch(0.145 0.03 250); }
  .stage { width: 100vw; height: 100vh; display: flex; align-items: center;
    justify-content: center; position: relative;
    /* The app's own dot grid (globals.css .dot-grid), with its radial mask so
       the texture breathes at the edges instead of tiling flatly. */
    background-image: radial-gradient(circle, oklch(0.55 0.1 250 / 0.5) 1.5px, transparent 1.5px);
    background-size: 24px 24px; }
  .stage::after { content: ''; position: absolute; inset: 0;
    background: radial-gradient(ellipse at center, transparent 0%, oklch(0.145 0.03 250) 78%); }
  /* Film grain over everything: the dark radial gradients band hard in 8-bit
     h264, and a few percent of animated luminance noise dithers the steps
     apart (static grain would read as a dirty lens — the tile's position is
     re-jittered every frame in the rAF loop below). */
  .grain { position: absolute; inset: 0; z-index: 2; pointer-events: none;
    opacity: 0.07; mix-blend-mode: overlay; background-repeat: repeat;
    will-change: background-position; }
  .lockup { position: relative; z-index: 1; }
  .lockup { display: flex; flex-direction: column; align-items: center;
    gap: 0; opacity: 0; transform: scale(0.4925) translateZ(0);
    will-change: transform, opacity; backface-visibility: hidden;
    font-family: 'Geist', system-ui, -apple-system, sans-serif;
    color: oklch(0.97 0.005 250); text-align: center; }
  .eye { width: ${eye}px; height: ${eye}px; }
  .eye svg { width: 100%; height: 100%; display: block; }
  .wordmark { font-size: ${wordmark}px; font-weight: 600; letter-spacing: 0.01em;
    margin-top: ${(isMain ? 22 : 16) * 2}px; }
  .eyebrow { font-size: ${(isMain ? 26 : 22) * 2}px; font-weight: 400;
    color: oklch(0.62 0.02 250); letter-spacing: 0.14em;
    margin-top: ${(isMain ? 54 : 40) * 2}px; }
  .heading { font-size: ${heading}px; font-weight: 650; line-height: 1.12;
    letter-spacing: -0.015em; max-width: 2800px;
    margin-top: ${(spec.eyebrow ? 10 : isMain ? 54 : 40) * 2}px; }
</style></head><body>
<div class="stage"><div class="grain" id="grain"></div><div class="lockup" id="lockup">
  <div class="eye">${EYE_SVG}</div>
  <div class="wordmark">owlette</div>
  ${spec.eyebrow ? `<div class="eyebrow">${spec.eyebrow}</div>` : ''}
  <div class="heading">${spec.heading}</div>
</div></div>
<script>
  // Noise tile for the grain layer, generated once: 256px of full-range
  // grayscale speckle, applied at low opacity with overlay blending above.
  (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 256) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    document.getElementById('grain').style.backgroundImage =
      'url(' + c.toDataURL() + ')';
  })();

  // rAF-driven (the capture pipeline is allergic to CSS animation timing):
  // fade in 0.45s, slow continuous scale 0.985 -> 1.05 across the whole card,
  // fade out over the last 0.45s. Started by the runner once the recorder has
  // its first frame, so the animation never begins off camera. The grain tile
  // jumps to a random offset every frame — live grain, not a static texture.
  window.__runCard = (durationMs) => new Promise((resolve) => {
    const el = document.getElementById('lockup');
    const grain = document.getElementById('grain');
    const FADE = 450;
    const t0 = performance.now();
    function step(now) {
      const t = now - t0;
      const p = Math.min(1, t / durationMs);
      const fadeIn = Math.min(1, t / FADE);
      const fadeOut = Math.min(1, (durationMs - t) / FADE);
      el.style.opacity = String(Math.max(0, Math.min(fadeIn, fadeOut)));
      el.style.transform =
        'scale(' + ((0.985 + 0.065 * p) / 2).toFixed(6) + ') translateZ(0)';
      grain.style.backgroundPosition =
        ((Math.random() * 256) | 0) + 'px ' + ((Math.random() * 256) | 0) + 'px';
      if (p < 1) requestAnimationFrame(step);
      else resolve(undefined);
    }
    requestAnimationFrame(step);
  });
</script></body></html>`;
}

async function renderCard(page: Page, spec: CardSpec): Promise<void> {
  const seconds = spec.kind === 'main' ? MAIN_SECONDS : SECTION_SECONDS;
  await page.setContent(cardHtml(spec), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const recorder = new FfmpegRecorder({
    outPath: path.join(OUT_DIR, `${spec.name}.mp4`),
    paths: planCapturePaths({ offsetX: 0, offsetY: 0, width: 1920, height: 1080 }),
  });
  await recorder.start();
  await page.waitForTimeout(250);
  await page.evaluate((ms) => (window as unknown as {
    __runCard: (ms: number) => Promise<void>;
  }).__runCard(ms), Math.round(seconds * 1000));
  await page.waitForTimeout(200);
  await recorder.stop();
  console.log(`  [card] ${spec.name}  ${seconds}s (${spec.kind})`);
}

function specsFromManifests(): CardSpec[] {
  const out: CardSpec[] = [];
  for (const file of readdirSync(MANIFESTS).filter((f) => f.endsWith('.json')).sort()) {
    const m = JSON.parse(readFileSync(path.join(MANIFESTS, file), 'utf-8')) as {
      episode: number;
      stem: string;
      title: string;
      beats: Array<{ id: string; title?: string; spoken?: boolean }>;
    };
    const nn = String(m.episode).padStart(2, '0');
    out.push({
      name: `${m.stem}-main`,
      kind: 'main',
      heading: m.title,
      eyebrow: `episode ${nn}`,
    });
    for (const b of m.beats) {
      if (!b.title) continue;
      out.push({ name: `${m.stem}-${b.id}`, kind: 'section', heading: b.title });
    }
  }
  return out;
}

test('render title cards', async ({ page, context }) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'fullscreen' },
  });
  // Let the transition + Chromium's "to exit full screen" bubble fade.
  await page.waitForTimeout(4_500);

  const mode = process.env.CARDS ?? 'preview';
  const specs =
    mode === 'batch'
      ? specsFromManifests()
      : [
          {
            name: 'preview-04-main',
            kind: 'main' as const,
            heading: 'the dashboard, end to end',
            eyebrow: 'episode 04',
          },
          {
            name: 'preview-04-b03',
            kind: 'section' as const,
            heading: 'reading a single card',
          },
        ];
  for (const spec of specs) {
    await renderCard(page, spec);
  }
});
