/**
 * Film the *installed* owlette desktop app — the video sibling of
 * `e2e/desktop-screenshots`, exactly as `e2e/videos` is the video sibling of
 * `e2e/screenshots`.
 *
 * Driving is CDP: `owlette-desktop.exe` is a Tauri 2 / WebView2 shell, and
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` turns its
 * webview into an ordinary debug endpoint that `chromium.connectOverCDP`
 * attaches to. Every hard state problem — a scratch `%PROGRAMDATA%`, a
 * redirected `COMPUTERNAME`, the layout file snapshotted and restored, the live
 * tray killed by verified pid, the pairing-phrase stub — is already solved in
 * `../desktop-screenshots/harness`, and is imported from there rather than
 * copied. Pixels come from `../videos/ffmpeg-recorder`, whose `CaptureRegion` is
 * already parameterized, so pointing it at a window rect is a caller change.
 *
 * WHY NOT the alternatives, both already settled in this repo:
 * - `tauri-driver` cannot own a window here. `tauri-plugin-single-instance` is a
 *   dependency and `lib.rs` forwards a second instance's argv to the first and
 *   exits, so a driver-spawned instance never gets one — and tauri-driver
 *   targets a dev build, when the whole point is filming the shipped binary.
 * - pywinauto/UIA over the window content exposes Tailwind class names, not
 *   stable Names (`dev/active/native-capture-pipeline/PLAN.md:55`). CDP gives
 *   the app's own testids. UIA is kept for what is genuinely native — the tray
 *   icon and its right-click menu — where `../desktop-screenshots/capture-tray-menu.ps1`
 *   already works.
 *
 * FRAMING — the first of the two deltas video has over stills. The shipped
 * window is 1060x640 with `decorations: false`; at 1080p that is a postage
 * stamp. This harness pins `layout.json` LARGER for the take (1600x900 by
 * default, `OWLETTE_DESKTOP_VIDEO_SIZE` overrides) and films exactly the
 * window's client rect at native resolution, rather than filming a 1920x1080
 * desktop with the window centred over it. Reasons, in order:
 *   - it depends on nothing outside the app. The desktop alternative needs a
 *     plain wallpaper and a hidden taskbar, neither of which this harness may
 *     set on the operator's machine, and both of which are baked into the
 *     footage if they are wrong;
 *   - the region is MEASURED, not assumed: the client rect is read back over
 *     CDP after the window is placed, so the frame is right whatever the display
 *     or the window manager did (the web harness's hardcoded `displayHeight =
 *     1080` is the bug this avoids);
 *   - 1600x900 is 16:9, so it lands on a 1080p timeline as one uniform 1.2x
 *     scale with no crop and no pillarbox — and it is a window size an operator
 *     would really use, so the sidebar/detail proportions on camera are honest.
 *     An operator with the room can shoot native by setting the env to 1920x1080.
 *
 * The second delta: a `connectOverCDP` context cannot use Playwright's
 * `recordVideo` at all. That costs nothing — the ffmpeg recorder is the chosen
 * path for the web scenes too.
 */

import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  CAPTURE_SIDEBAR_WIDTH,
  CDP_PORT,
  SCRATCH_ROOT,
  clearSession,
  startDesktop,
  stopDesktop,
  writeSession,
  type DesktopSession,
} from '../desktop-screenshots/harness';
import {
  FfmpegRecorder,
  planCapturePaths,
  type CaptureRegion,
} from '../videos/ffmpeg-recorder';
import { installFakeCursor, beginTake, finishTake, assertEdgesClean } from './video-helpers';

/** Clean, named .mp4 output lands here. */
// Same home as the web takes: the production workspace owns the media.
export const VIDEO_OUT_DIR = path.resolve(
  __dirname, '..', '..', '..', 'dev', 'video-tutorials', 'footage', 'desktop');

/** Held on the start/end frame so every clip has stable bookends. */
const PRE_ROLL_MS = 150;
const POST_ROLL_MS = 150;

/** See the framing note above. 16:9, and inside a 1920x1080 work area. */
const DEFAULT_CAPTURE_SIZE = { width: 1600, height: 900 } as const;

/** The sidebar the stills pin, kept: it is the width the app ships with. */
export const CAPTURE_SIDEBAR = CAPTURE_SIDEBAR_WIDTH;

export interface CaptureSize {
  width: number;
  height: number;
}

/**
 * Window size for this take. `OWLETTE_DESKTOP_VIDEO_SIZE=1920x1080` films
 * native on a display with the room for it.
 */
export function videoWindowSize(): CaptureSize {
  const raw = (process.env.OWLETTE_DESKTOP_VIDEO_SIZE ?? '').trim().toLowerCase();
  if (!raw) return { ...DEFAULT_CAPTURE_SIZE };

  const match = /^(\d{3,5})x(\d{3,5})$/.exec(raw);
  if (!match) {
    console.warn(
      `[desktop-video] ignoring OWLETTE_DESKTOP_VIDEO_SIZE=${raw} (expected e.g. 1600x900)`,
    );
    return { ...DEFAULT_CAPTURE_SIZE };
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

const POSITION_SCRIPT = path.resolve(__dirname, 'position-window.ps1');

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionResult {
  window: Rect;
  client: { width: number; height: number };
  workArea: Rect;
}

/**
 * Size and centre the window. See `position-window.ps1` for why this is native:
 * the app remembers its size but never its position, so a window pinned larger
 * than the configured 1060x640 keeps the small window's centred top-left and
 * can hang off the display.
 */
function positionWindow(pid: number, size: CaptureSize): PositionResult {
  let output: string;
  try {
    output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        POSITION_SCRIPT,
        '-ProcessId',
        String(pid),
        '-Width',
        String(size.width),
        '-Height',
        String(size.height),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
  } catch (cause) {
    // The script's own diagnosis (window does not fit, no main window yet, a
    // win32 error code) is on stderr; `execFileSync`'s message is only
    // "Command failed", which sends the operator nowhere.
    const stderr = (cause as { stderr?: string }).stderr ?? '';
    throw new Error(
      `position-window.ps1 failed for pid ${pid} at ${size.width}x${size.height}: ` +
      `${stderr.trim() || String(cause)}`,
    );
  }
  return JSON.parse(output.trim()) as PositionResult;
}

interface ClientMeasurement {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  displayWidth: number;
  displayHeight: number;
}

/** The webview's own view of where it sits, in CSS px. */
function measureClient(page: Page): Promise<ClientMeasurement> {
  return page.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    displayWidth: window.screen.width,
    displayHeight: window.screen.height,
  }));
}

/**
 * Place the window and hand back the region ffmpeg should film.
 *
 * `MoveWindow` takes a WINDOW rect while ffmpeg needs the CLIENT rect, and a
 * borderless Tauri window still carries an invisible resize frame on some
 * builds — so the size is converged rather than assumed: place, measure the
 * client rect over CDP, correct by the difference, place again.
 *
 * The offset cannot be converged the same way — nothing re-measures it — so it
 * is cross-checked instead, against the window and client rects the placement
 * script already returns. See the checks below for why the horizontal inset is
 * asserted exactly and the vertical one only bounded.
 */
export async function frameWindow(
  session: DesktopSession,
  page: Page,
  size: CaptureSize,
): Promise<CaptureRegion> {
  if (size.width % 2 !== 0 || size.height % 2 !== 0) {
    throw new Error(
      `capture size ${size.width}x${size.height} has an odd dimension — yuv420p needs both even`,
    );
  }

  const attempts = 3;
  let outer: CaptureSize = { ...size };
  let measured: ClientMeasurement | null = null;
  let placed: PositionResult | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    placed = positionWindow(session.pid, outer);
    // The window manager settles asynchronously; the webview resizes with it.
    await page.waitForTimeout(300);
    measured = await measureClient(page);

    if (measured.width === size.width && measured.height === size.height) break;
    if (attempt === attempts) {
      throw new Error(
        `could not size the owlette window to ${size.width}x${size.height}: ` +
        `client rect settled at ${measured.width}x${measured.height} after ${attempts} attempts ` +
        `(work area ${placed.workArea.width}x${placed.workArea.height}). ` +
        'Lower OWLETTE_DESKTOP_VIDEO_SIZE, or check the display is at 100% scaling.',
      );
    }
    outer = {
      width: outer.width + (size.width - measured.width),
      height: outer.height + (size.height - measured.height),
    };
  }

  // Both are assigned on every iteration and the loop runs at least once.
  const client = measured!;
  const frame = placed!;

  if (client.dpr !== 1) {
    throw new Error(
      `capture DPR mismatch: devicePixelRatio ${client.dpr} != 1. ` +
      'Set the primary monitor to 100% Windows scaling and re-run — ddagrab captures ' +
      'physical pixels, so anything else films a region the app is not drawing in.',
    );
  }

  // The capture SIZE is converged above; the capture OFFSET is `window.screenX/
  // screenY` taken on trust. Cross-check it against the rects
  // `position-window.ps1` already handed back, because the failure it guards is
  // silent: if Blink reported the HOST window rect rather than the WebView2
  // controller bounds, every frame would sit one invisible resize border off and
  // nothing downstream would notice until the edit.
  //
  // Safe now that DPR is known to be 1: `GetClientRect` is physical px and
  // `innerWidth` is CSS px, so the two are directly comparable.
  const slackX = frame.window.width - frame.client.width;
  const slackY = frame.window.height - frame.client.height;
  const insetX = client.x - frame.window.x;
  const insetY = client.y - frame.window.y;

  if (
    Math.abs(client.width - frame.client.width) > 1 ||
    Math.abs(client.height - frame.client.height) > 1
  ) {
    throw new Error(
      'the webview does not fill the host client area: the page reports ' +
      `${client.width}x${client.height} where GetClientRect reports ` +
      `${frame.client.width}x${frame.client.height}. The capture offset comes from the ` +
      'page, so it is only trustworthy while those two agree.',
    );
  }
  // Left and right window borders are always equal on Windows, so the
  // horizontal inset is exact — and a shifted origin shows up here first,
  // because any frame at all makes it non-zero. The vertical is only BOUNDED,
  // never equated: `GetWindowRect` includes the DWM shadow region, which is not
  // symmetric top-to-bottom, so asserting `insetY === slackY / 2` would fail on
  // a correctly placed window.
  if (Math.abs(insetX - slackX / 2) > 1) {
    throw new Error(
      `capture offset cross-check failed: the page puts its client origin ${insetX}px inside ` +
      `the window's left edge, but a ${frame.window.width}px window around a ` +
      `${frame.client.width}px client area has a ${slackX / 2}px border. window.screenX is ` +
      'likely reporting the host window rect rather than the WebView2 controller bounds — ' +
      'ffmpeg would film a region shifted by the resize frame.',
    );
  }
  if (insetY < -1 || insetY > slackY + 1) {
    throw new Error(
      `capture offset cross-check failed: the page puts its client origin ${insetY}px below ` +
      `the window's top edge, outside the 0..${slackY}px a ${frame.window.height}px window ` +
      `around a ${frame.client.height}px client area allows.`,
    );
  }

  if (
    client.x < 0 ||
    client.y < 0 ||
    client.x + client.width > client.displayWidth ||
    client.y + client.height > client.displayHeight
  ) {
    throw new Error(
      `the owlette window is not fully on the primary display: client rect ` +
      `${client.width}x${client.height} at (${client.x}, ${client.y}) on a ` +
      `${client.displayWidth}x${client.displayHeight} display. ` +
      'ddagrab clips silently, so this fails instead.',
    );
  }

  const region: CaptureRegion = {
    offsetX: client.x,
    offsetY: client.y,
    width: client.width,
    height: client.height,
  };
  console.log(
    `[desktop-video] capture region: ${region.width}x${region.height} ` +
    `at (${region.offsetX}, ${region.offsetY})`,
  );
  return region;
}

/** Attach to the app's webview. No browser is launched. */
export async function attachDesktop(port: number): Promise<{ browser: Browser; page: Page }> {
  // WebView2 parks at about:blank until the frontend navigates, and the CDP
  // endpoint usually accepts connections before that — so poll instead of
  // judging the first snapshot. A plain launch loses that race where --pair's
  // slower startup path won it, which is how ep09 failed while ep03 passed.
  const deadline = Date.now() + 15_000;
  let lastSeen = '(none)';
  for (;;) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts()[0]?.pages() ?? [];
    const found = pages.find((candidate) => candidate.url().includes('tauri.localhost'));
    if (found) return { browser, page: found };
    lastSeen = pages.map((candidate) => candidate.url()).join(', ') || '(none)';
    await browser.close();
    if (Date.now() > deadline) {
      throw new Error(`no owlette webview on the debug port after 15s (saw: ${lastSeen})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export interface DesktopTake {
  session: DesktopSession;
  browser: Browser;
  page: Page;
  region: CaptureRegion;
}

/**
 * Start one take: launch the app over the scratch tree, attach, frame it, and
 * draw the pointer.
 *
 * One app launch per take rather than one per suite, because the argv is part
 * of the subject — the pairing scene has to film the dialog the installer's
 * `--pair` handoff opens, and that only happens at startup.
 *
 * The caller seeds the scenario FIRST, so the app's first paint is already
 * showing fixture data rather than an empty document.
 */
export async function startTake(args: readonly string[] = []): Promise<DesktopTake> {
  const session = await startDesktop(SCRATCH_ROOT, CDP_PORT, args);
  writeSession(session);

  const { browser, page } = await attachDesktop(session.port);
  try {
    const region = await frameWindow(session, page, videoWindowSize());
    await installFakeCursor(page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return { session, browser, page, region };
  } catch (cause) {
    // The caller has no take to tear down, so the connection is ours to drop.
    // The app itself is left for global teardown, which stops it from the
    // session file this function already wrote.
    await browser.close().catch(() => undefined);
    throw cause;
  }
}

/**
 * End a take. Disconnecting first is deliberate: `stopDesktop` kills the process
 * the webview belongs to, and a still-attached Playwright browser then reports
 * the teardown as a failure.
 */
export async function endTake(take: DesktopTake | null): Promise<void> {
  if (!take) return;
  try {
    await take.browser.close();
  } catch {
    // The webview may already be gone; the kill below is what matters.
  }
  await stopDesktop(take.session);
  clearSession();
}

/**
 * Run `scene` with ffmpeg filming the window, saving to
 * `dev/video-tutorials/footage/desktop/{sceneName}.mp4`.
 *
 * A throwing scene still stops the recorder in `finally` — no orphaned ffmpeg —
 * and `FfmpegRecorder.stop`'s temp→final rename means a half-written file never
 * poses as a valid clip. Unlike the web `recordScene` this does not close
 * anything afterwards: the page belongs to the app, and the take owns its
 * lifetime.
 */
export async function recordDesktopScene(
  take: DesktopTake,
  sceneName: string,
  scene: (page: Page) => Promise<void>,
): Promise<string> {
  await mkdir(VIDEO_OUT_DIR, { recursive: true });
  const outPath = path.join(VIDEO_OUT_DIR, `${sceneName}.mp4`);

  const recorder = new FfmpegRecorder({
    outPath,
    paths: planCapturePaths(take.region),
    onStderr: (line) => {
      if (/error|fatal/i.test(line)) console.warn(`[ffmpeg] ${line}`);
    },
  });

  await recorder.start();
  beginTake(take.page, sceneName, outPath, recorder.videoEpochMs ?? undefined);
  await take.page.waitForTimeout(PRE_ROLL_MS);

  let sceneError: unknown = null;
  try {
    await scene(take.page);
    await finishTake(take.page);
    await take.page.waitForTimeout(POST_ROLL_MS);
  } catch (e) {
    sceneError = e;
  } finally {
    try {
      await recorder.stop();
    } catch (stopErr) {
      console.warn(`[recordDesktopScene] recorder.stop error: ${stopErr}`);
    }
  }

  if (sceneError) throw sceneError;
  // Same post-take pixel audit as the web harness — a take with desktop pixels
  // at its edges fails here instead of shipping.
  assertEdgesClean(outPath);
  return outPath;
}
