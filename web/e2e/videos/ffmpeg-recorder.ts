/**
 * FfmpegRecorder — owns the lifecycle of an ffmpeg desktop-capture subprocess that
 * runs alongside a Playwright scene. Replaces Playwright's built-in `recordVideo`
 * (which is locked to 25fps VP8 and grabs frames opportunistically — fine for test
 * debugging, wrong for production tutorial video).
 *
 * Lifecycle contract:
 *   1. start()  — spawns ffmpeg, awaits a "first frame written" signal (output file
 *                 grows past a header-only threshold), 5s timeout. After this we know
 *                 capture is live and the scene can safely begin.
 *   2. scene runs                                                  (caller's `try`)
 *   3. stop()   — writes `q\n` to ffmpeg's stdin so it can flush mp4 headers/moov
 *                 cleanly, then awaits the process exit with a 10s watchdog. If the
 *                 watchdog trips we kill the PROCESS TREE via `taskkill /F /T /PID`
 *                 — PID-targeted only, NEVER `/IM` (codebase rule, see
 *                 `.claude/.../memory/feedback_targeted_process_kill.md`).
 *   4. On success the .tmp.mp4 is renamed to the final path so a half-captured file
 *      never looks valid to downstream tools.
 *
 * Process-level shutdown hooks (SIGINT, beforeExit) are registered so that pressing
 * Ctrl+C mid-scene reaps the subprocess instead of leaving an orphan running and
 * occupying the GPU/encoder.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** Active recorders, drained on process exit. */
const ACTIVE: Set<FfmpegRecorder> = new Set();
let shutdownHooksRegistered = false;
function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  const drain = (): void => {
    for (const r of ACTIVE) r.killNow();
  };
  process.on('SIGINT', drain);
  process.on('SIGTERM', drain);
  process.on('beforeExit', drain);
}

export interface FfmpegRecorderOptions {
  /** Final output path, e.g. `e2e/.output/videos/01-what-is-owlette.mp4`. */
  outPath: string;
  /**
   * ffmpeg args EXCLUDING the trailing output filename — the recorder appends the
   * temp file path. So pass everything from `-y` through the encoder/colorspace
   * flags, but not the final filename argument.
   */
  args: string[];
  /** Watchdog for `q\n` shutdown, in ms (default 10_000). */
  shutdownTimeoutMs?: number;
  /** Timeout for first-frame readiness (stderr `frame=N` regex), in ms (default 8_000). */
  startTimeoutMs?: number;
  /** Optional sink for ffmpeg stderr lines (debugging). Errors written here regardless. */
  onStderr?: (line: string) => void;
}

export class FfmpegRecorder {
  private proc: ChildProcess | null = null;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private tmpPath: string;
  private stderrBuf = '';
  private stopped = false;

  constructor(private readonly opts: FfmpegRecorderOptions) {
    this.tmpPath = this.opts.outPath + '.tmp.mp4';
  }

  /**
   * Spawn ffmpeg and resolve once the temp output file has grown past
   * `firstFrameMinBytes`, indicating capture has actually started writing frames.
   * Rejects on ffmpeg early-exit (bad args, missing capture device) or first-frame
   * timeout.
   */
  async start(): Promise<void> {
    registerShutdownHooks();
    mkdirSync(path.dirname(this.tmpPath), { recursive: true });
    if (existsSync(this.tmpPath)) {
      try { unlinkSync(this.tmpPath); } catch { /* best-effort */ }
    }

    this.proc = spawn('ffmpeg', [...this.opts.args, this.tmpPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    ACTIVE.add(this);

    this.exitPromise = new Promise((resolve) => {
      this.proc!.once('exit', (code, signal) => {
        ACTIVE.delete(this);
        resolve({ code, signal });
      });
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuf += text;
      if (this.opts.onStderr) {
        for (const line of text.split(/\r?\n/)) if (line) this.opts.onStderr(line);
      }
    });

    const startTimeoutMs = this.opts.startTimeoutMs ?? 8_000;
    const startedAt = Date.now();

    // First-frame readiness via stderr `frame= N` parsing, NOT output file size.
    // With `-movflags +faststart` the muxer buffers frames until close so it can
    // put the moov atom at the start of the file — the .mp4 stays near-empty
    // (just the ftyp header) for the entire capture. The encoder's stats line
    // (`frame=N fps=… q=…`) is the authoritative signal that frames are actually
    // flowing through ddagrab → NVENC, irrespective of when bytes land on disk.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        if (err) reject(err);
        else resolve();
      };

      this.exitPromise!.then(({ code, signal }) => {
        if (!settled) {
          finish(new Error(
            `ffmpeg exited during startup (code=${code} signal=${signal})\n` +
            `stderr tail:\n${this.stderrBuf.slice(-1500)}`,
          ));
        }
      });

      const poll = setInterval(() => {
        if (/frame=\s*[1-9]\d*/.test(this.stderrBuf)) finish();
        else if (Date.now() - startedAt > startTimeoutMs) {
          finish(new Error(
            `ffmpeg first-frame timeout after ${startTimeoutMs}ms (no frame=N in stderr)\n` +
            `stderr tail:\n${this.stderrBuf.slice(-1500)}`,
          ));
        }
      }, 50);
    });
  }

  /**
   * Send `q` to ffmpeg's stdin so it writes the trailing mp4 atoms (essential —
   * without `q` the moov atom can be missing on some muxers and the file is
   * unseekable in any NLE), await the process exit with a watchdog, and rename
   * the temp file to the final path on success.
   */
  async stop(): Promise<void> {
    if (!this.proc || this.stopped) return;
    this.stopped = true;

    const proc = this.proc;
    try {
      proc.stdin!.write('q\n');
      proc.stdin!.end();
    } catch { /* process may have exited already */ }

    const watchdog = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), this.opts.shutdownTimeoutMs ?? 10_000);
    });
    const result = await Promise.race([this.exitPromise!, watchdog]);

    if (result === 'timeout') {
      // PID-targeted kill — never name-kill (codebase rule).
      this.killTreeSync();
      // Give the OS a moment to reap.
      await Promise.race([
        this.exitPromise!,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }

    this.proc = null;

    if (!existsSync(this.tmpPath) || statSync(this.tmpPath).size === 0) {
      throw new Error(
        `ffmpeg shutdown produced no output (path=${this.tmpPath})\n` +
        `stderr tail:\n${this.stderrBuf.slice(-1500)}`,
      );
    }

    // Rename atomically — only on a successful capture does the final filename appear.
    if (existsSync(this.opts.outPath)) {
      try { unlinkSync(this.opts.outPath); } catch { /* overwrite */ }
    }
    renameSync(this.tmpPath, this.opts.outPath);
  }

  /** Synchronous best-effort kill used from process-shutdown hooks. */
  killNow(): void {
    if (!this.proc) return;
    this.killTreeSync();
    this.proc = null;
    ACTIVE.delete(this);
  }

  private killTreeSync(): void {
    if (!this.proc || this.proc.pid === undefined) return;
    // `taskkill /F /T /PID <pid>`  — PID-targeted, /T includes the whole tree.
    // NEVER `/IM ffmpeg.exe` (would wipe unrelated ffmpeg processes).
    spawnSync('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], {
      windowsHide: true,
      timeout: 3_000,
    });
  }
}

export interface CaptureRegion {
  /** Pixels from the left edge of the primary monitor. */
  offsetX: number;
  /** Pixels from the top edge of the primary monitor (== chrome UI height). */
  offsetY: number;
  /** Capture width — should be 1920 for the production pipeline. */
  width: number;
  /** Capture height — should be 1080 for the production pipeline. */
  height: number;
}

/**
 * Production-quality args for the primary capture path on Windows: DXGI Desktop
 * Duplication (`ddagrab`) → BGRA → yuv420p → NVENC H.264 with offline-quality
 * tuning, GOP 60 (frame-accurate scrub in NLE), bt709 color metadata so the
 * editor doesn't inflate blacks, and `+faststart` so the moov atom is up front.
 *
 * The capture region is dynamic because Chromium ships chrome UI (tabs + address
 * bar) above the content viewport — `recordScene` measures that height at
 * runtime and passes it in, so ffmpeg captures only the page itself.
 *
 * Verified end-to-end on this dev machine by `web/scripts/probe-capture.mjs`.
 */
export function buildPrimaryFfmpegArgs(region: CaptureRegion): string[] {
  return [
    // `-loglevel warning` (vs `error`) + `-stats` so a stalled capture leaves a
    // diagnostic trail in stderr — empty stderr was the failure-mode that made
    // the first ddagrab-vs-kiosk regression hard to triage.
    '-y', '-hide_banner', '-loglevel', 'warning', '-stats',
    '-filter_complex',
    `ddagrab=output_idx=0:framerate=60:draw_mouse=0:offset_x=${region.offsetX}:offset_y=${region.offsetY}:video_size=${region.width}x${region.height},hwdownload,format=bgra,format=yuv420p`,
    '-c:v', 'h264_nvenc',
    '-preset', 'p5', '-tune', 'hq',
    '-rc', 'constqp', '-qp', '18',
    '-bf', '2',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-movflags', '+faststart',
  ];
}

/**
 * Fallback args (GDI → libx264) for machines without DXGI/NVENC. Slower, higher
 * CPU, capped framerate, but produces an equivalent-format mp4 file so
 * downstream tooling doesn't special-case anything.
 */
export function buildFallbackFfmpegArgs(region: CaptureRegion): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'warning', '-stats',
    '-f', 'gdigrab', '-draw_mouse', '0',
    '-framerate', '60',
    '-video_size', `${region.width}x${region.height}`,
    '-offset_x', String(region.offsetX), '-offset_y', String(region.offsetY),
    '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-bf', '2',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-movflags', '+faststart',
  ];
}

/**
 * Run ffprobe against a finished capture and throw if the file isn't a real 1920x1080
 * h264 yuv420p mp4 of approximately the expected duration. This is the third leg of
 * the synthesis's "write to temp + assert + rename" pattern — combined with the
 * temp→final rename in `FfmpegRecorder.stop`, a broken capture is never silently
 * left looking valid.
 */
export function assertCaptureValid(
  outPath: string,
  expectedSeconds: number,
  durationToleranceSec = 5,
): void {
  const r = spawnSync(
    'ffprobe',
    [
      '-hide_banner', '-loglevel', 'error',
      '-show_entries', 'stream=width,height,codec_name,avg_frame_rate,pix_fmt',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1',
      outPath,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (r.status !== 0) {
    throw new Error(`ffprobe failed on ${outPath}: ${r.stderr}`);
  }
  const meta = Object.fromEntries(
    (r.stdout ?? '')
      .split('\n')
      .map((l) => l.replace(/\r$/, '').split('='))
      .filter((x) => x.length === 2)
      .map(([k, v]) => [k.trim(), v.trim()]),
  );
  const w = Number(meta.width);
  const h = Number(meta.height);
  const duration = Number(meta.duration);
  const problems: string[] = [];
  if (w !== 1920 || h !== 1080) problems.push(`size ${w}x${h} != 1920x1080`);
  if (meta.codec_name !== 'h264') problems.push(`codec ${meta.codec_name} != h264`);
  if (meta.pix_fmt !== 'yuv420p') problems.push(`pix_fmt ${meta.pix_fmt} != yuv420p`);
  if (Math.abs(duration - expectedSeconds) > durationToleranceSec) {
    problems.push(`duration ${duration.toFixed(2)}s not within ${durationToleranceSec}s of expected ${expectedSeconds}s`);
  }
  if (problems.length) {
    throw new Error(`capture validation failed for ${outPath}: ${problems.join('; ')}`);
  }
}
