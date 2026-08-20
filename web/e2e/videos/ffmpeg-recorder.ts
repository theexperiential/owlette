/**
 * FfmpegRecorder — lifecycle of an ffmpeg desktop-capture subprocess running
 * alongside a Playwright scene. Playwright's `recordVideo` is 25fps VP8 with
 * opportunistic frame grabs: fine for debugging, wrong for tutorial video.
 *
 * start() spawns ffmpeg and waits for first-frame; stop() sends `q\n` so ffmpeg
 * flushes the moov atom, then waits on exit behind a watchdog. If the watchdog
 * trips, kill the PROCESS TREE by PID (`taskkill /F /T /PID`) — never `/IM`
 * (codebase rule: feedback_targeted_process_kill.md). Success renames .tmp.mp4
 * to the final path, so a half-captured file never looks valid downstream.
 *
 * SIGINT/SIGTERM/beforeExit hooks reap the subprocess, or Ctrl+C mid-scene
 * orphans ffmpeg holding the encoder.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

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
  /** Final output path. */
  outPath: string;
  /** ffmpeg args EXCLUDING the output filename — the recorder appends the temp path. */
  args: string[];
  /** Watchdog for `q\n` shutdown, ms (default 10_000). */
  shutdownTimeoutMs?: number;
  /** First-frame readiness timeout, ms (default 8_000). */
  startTimeoutMs?: number;
  /** Optional sink for ffmpeg stderr lines. */
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
   * Spawn ffmpeg and resolve once frames are confirmed flowing. Rejects on early
   * exit (bad args, missing capture device) or first-frame timeout.
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

    // Readiness comes from stderr `frame=N`, NOT file size: `+faststart` makes
    // the muxer buffer until close so the .mp4 stays ftyp-header-sized for the
    // whole capture. The stats line is the only signal frames are really flowing.
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
   * Send `q` to stdin so ffmpeg writes the trailing mp4 atoms — without it some
   * muxers omit the moov and the file is unseekable in any NLE. Then await exit
   * behind a watchdog and rename temp → final.
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

    // Only a successful capture gets the final filename.
    if (existsSync(this.opts.outPath)) {
      try { unlinkSync(this.opts.outPath); } catch { /* overwrite */ }
    }
    renameSync(this.tmpPath, this.opts.outPath);
  }

  /** Sync best-effort kill, for shutdown hooks. */
  killNow(): void {
    if (!this.proc) return;
    this.killTreeSync();
    this.proc = null;
    ACTIVE.delete(this);
  }

  private killTreeSync(): void {
    if (!this.proc || this.proc.pid === undefined) return;
    // PID-targeted, /T for the tree. NEVER `/IM ffmpeg.exe` — that would wipe
    // the operator's unrelated ffmpeg processes.
    spawnSync('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], {
      windowsHide: true,
      timeout: 3_000,
    });
  }
}

export interface CaptureRegion {
  /** px from the primary monitor's left edge. */
  offsetX: number;
  /** px from the top edge (== chrome UI height). */
  offsetY: number;
  /** 1920 in the production pipeline. */
  width: number;
  /** 1080 in the production pipeline. */
  height: number;
}

/**
 * Primary Windows capture path: DXGI Desktop Duplication (`ddagrab`) → BGRA →
 * yuv420p → NVENC H.264. GOP 60 for frame-accurate NLE scrub, bt709 metadata so
 * the editor doesn't inflate blacks, `+faststart` for a leading moov atom.
 *
 * The region is dynamic because Chromium's tab + address bar sit above the
 * viewport; `recordScene` measures that height at runtime.
 */
export function buildPrimaryFfmpegArgs(region: CaptureRegion): string[] {
  return [
    // `warning` (not `error`) + `-stats`: an empty stderr made the first
    // ddagrab-vs-kiosk regression untriageable.
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
 * Fallback (GDI → libx264) for machines without DXGI/NVENC. Slower and CPU-heavy,
 * but format-identical so downstream tooling needs no special case.
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
 * ffprobe a finished capture; throw unless it's a 1920x1080 h264 yuv420p mp4 of
 * roughly the expected duration. Third leg of write-temp → assert → rename, so a
 * broken capture never sits around looking valid.
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
