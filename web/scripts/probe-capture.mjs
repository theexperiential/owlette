#!/usr/bin/env node
/**
 * probe-capture.mjs — hard-gate smoke test for the tutorial-video capture pipeline.
 *
 * Validates on THIS machine that ffmpeg can:
 *   1. encode through h264_nvenc with the production NVENC params,
 *   2. capture the real Windows desktop via the ddagrab filter (DXGI Desktop Duplication),
 *   3. produce a 60fps 1920x1080 H.264 mp4 that ffprobe accepts.
 *
 * Also captures via gdigrab + libx264 so the fallback path is proven before we'd ever
 * need it. Outputs go to a tmp dir and are deleted on success — nothing committed.
 *
 * Run:  cd web && node scripts/probe-capture.mjs
 * Exit: 0  primary  (ddagrab + h264_nvenc) works → ready for production
 *       1  degraded (primary failed, fallback works) → can still record at lower quality
 *       2  hard stop (no working pipeline)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT_DIR = join(tmpdir(), 'owlette-probe-capture');
mkdirSync(OUT_DIR, { recursive: true });

const SHARED_OUT_FLAGS = [
  '-bf', '2',
  '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
  '-color_range', 'tv',
  '-colorspace', 'bt709',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-movflags', '+faststart',
];

function run(cmd, args, { timeoutMs = 30000 } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function header(label) { console.log(`\n=== ${label} ===`); }
function pass(msg)     { console.log(`  PASS  ${msg}`); }
function fail(msg)     { console.log(`  FAIL  ${msg}`); }
function note(msg)     { console.log(`  -     ${msg}`); }

function ffprobeMeta(path) {
  const r = run('ffprobe', [
    '-hide_banner', '-loglevel', 'error',
    '-show_entries', 'stream=width,height,codec_name,avg_frame_rate,pix_fmt',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1',
    path,
  ]);
  // ffprobe on Windows outputs CRLF; trim each value so 'h264' doesn't compare as 'h264\r'.
  const meta = Object.fromEntries(
    r.stdout
      .split('\n')
      .map((l) => l.replace(/\r$/, '').split('='))
      .filter((x) => x.length === 2)
      .map(([k, v]) => [k.trim(), v.trim()]),
  );
  const [a, b] = String(meta.avg_frame_rate || '').split('/').map(Number);
  return {
    width: Number(meta.width),
    height: Number(meta.height),
    codec: meta.codec_name,
    fps: b ? a / b : a,
    pixFmt: meta.pix_fmt,
    duration: Number(meta.duration),
    raw: meta,
  };
}

function describeMeta(m) {
  return `${m.codec} ${m.width}x${m.height} @ ${m.fps.toFixed(1)}fps ${m.pixFmt} ${m.duration.toFixed(2)}s`;
}

/**
 * Validate the file is a real 1920x1080 h264 mp4 of roughly the right length.
 * Pass `checkFps: true` only for SYNTHETIC sources (testsrc2). For real-desktop
 * captures the framerate is determined by how often the desktop actually updates —
 * an idle desktop emits far fewer than 60 fps via DXGI Desktop Duplication, so
 * gating on 60fps would falsely fail a perfectly healthy pipeline. The probe's job
 * is to verify the pipeline encodes a valid file; the *live capture* against an
 * animating Chromium is what produces true 60fps.
 */
function assertMeta(m, { checkFps = false } = {}) {
  if (m.width !== 1920 || m.height !== 1080) return `size ${m.width}x${m.height} != 1920x1080`;
  if (m.codec !== 'h264') return `codec ${m.codec} != h264`;
  if (m.pixFmt !== 'yuv420p') return `pix_fmt ${m.pixFmt} != yuv420p`;
  if (Math.abs(m.duration - 2) > 0.6) return `duration ${m.duration.toFixed(2)}s not within 0.6s of 2.0s`;
  if (checkFps && Math.abs(m.fps - 60) > 2) return `fps ${m.fps.toFixed(1)} not within 2 of 60 (synthetic source must hit exactly 60)`;
  return null;
}

function cleanup(path) { try { if (existsSync(path)) unlinkSync(path); } catch {} }

// ─── 1. ffmpeg present ─────────────────────────────────────────────────────────
header('1. ffmpeg + capability detection');
let r = run('ffmpeg', ['-hide_banner', '-version']);
if (r.code !== 0) {
  fail(`ffmpeg not found or non-zero exit: ${r.stderr.slice(0, 200)}`);
  process.exit(2);
}
const version = (r.stdout.match(/ffmpeg version (\S+)/) || [])[1] || '?';
pass(`ffmpeg ${version}`);

const filters  = run('ffmpeg', ['-hide_banner', '-filters']).stdout;
const encoders = run('ffmpeg', ['-hide_banner', '-encoders']).stdout;
const devices  = run('ffmpeg', ['-hide_banner', '-devices']).stdout;

const has = {
  ddagrab: /\bddagrab\b/.test(filters),
  gdigrab: /\bgdigrab\b/.test(devices),
  nvenc:   /\bh264_nvenc\b/.test(encoders),
  libx264: /\blibx264\b/.test(encoders),
};
note(`ddagrab : ${has.ddagrab ? 'available' : 'MISSING'}`);
note(`gdigrab : ${has.gdigrab ? 'available' : 'MISSING'}`);
note(`h264_nvenc : ${has.nvenc   ? 'available' : 'MISSING'}`);
note(`libx264 : ${has.libx264 ? 'available' : 'MISSING'}`);

// ─── 2. DPI scaling sanity (warn-only) ─────────────────────────────────────────
header('2. primary monitor DPI (LOGPIXELSX, 96 = 100%)');
const psCmd = `Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class DPI {
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    public static int Get() { return GetDeviceCaps(GetDC(IntPtr.Zero), 88); }
  }
"@
[DPI]::Get()`;
const ps = run('powershell', ['-NoProfile', '-Command', psCmd], { timeoutMs: 10000 });
const dpi = Number(String(ps.stdout || '').trim().split(/\s+/).pop());
if (!Number.isFinite(dpi)) {
  note(`could not read DPI (powershell output: ${ps.stdout.slice(0, 80)})`);
} else {
  const scalingPct = Math.round((dpi / 96) * 100);
  if (scalingPct === 100) pass(`DPI ${dpi} (${scalingPct}% scaling) — ddagrab and Chromium viewport will align`);
  else fail(`DPI ${dpi} (${scalingPct}% scaling) — set primary monitor to 100% before recording, or ddagrab's 1920x1080 region will not match Chromium's 1920x1080 viewport`);
}

// ─── 3. NVENC encoder smoke (synthetic) ────────────────────────────────────────
header('3. NVENC encoder smoke  (testsrc2 → h264_nvenc with production params)');
let nvencEncoderOk = false;
if (has.nvenc) {
  const out = join(OUT_DIR, 'nvenc-encoder.mp4');
  cleanup(out);
  const e = run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60',
    '-t', '2',
    '-c:v', 'h264_nvenc',
    '-preset', 'p5', '-tune', 'hq',
    '-rc', 'constqp', '-qp', '18',
    ...SHARED_OUT_FLAGS,
    out,
  ]);
  if (e.code === 0 && existsSync(out)) {
    const meta = ffprobeMeta(out);
    const problem = assertMeta(meta, { checkFps: true });
    if (!problem) { pass(describeMeta(meta)); nvencEncoderOk = true; }
    else          { fail(`${problem} — ${describeMeta(meta)}`); }
    cleanup(out);
  } else {
    fail(`encode failed (exit ${e.code}): ${e.stderr.slice(0, 400)}`);
  }
} else {
  fail('h264_nvenc not present — skipping');
}

// ─── 4. PRIMARY: ddagrab → h264_nvenc (real desktop) ───────────────────────────
header('4. PRIMARY pipeline smoke  (ddagrab desktop → h264_nvenc)');
let primaryOk = false;
if (has.ddagrab && has.nvenc) {
  const out = join(OUT_DIR, 'primary.mp4');
  cleanup(out);
  const e = run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-filter_complex', 'ddagrab=output_idx=0:framerate=60:draw_mouse=0,hwdownload,format=bgra,format=yuv420p',
    '-t', '2',
    '-c:v', 'h264_nvenc',
    '-preset', 'p5', '-tune', 'hq',
    '-rc', 'constqp', '-qp', '18',
    ...SHARED_OUT_FLAGS,
    out,
  ]);
  if (e.code === 0 && existsSync(out)) {
    const meta = ffprobeMeta(out);
    const problem = assertMeta(meta);
    if (!problem) { pass(describeMeta(meta)); primaryOk = true; }
    else          { fail(`${problem} — ${describeMeta(meta)}`); }
    cleanup(out);
  } else {
    fail(`ddagrab capture failed (exit ${e.code}): ${e.stderr.slice(0, 600)}`);
  }
} else {
  fail('ddagrab or h264_nvenc missing — skipping primary');
}

// ─── 5. FALLBACK: gdigrab → libx264 ────────────────────────────────────────────
header('5. FALLBACK pipeline smoke (gdigrab desktop → libx264)');
let fallbackOk = false;
if (has.gdigrab && has.libx264) {
  const out = join(OUT_DIR, 'fallback.mp4');
  cleanup(out);
  const e = run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-draw_mouse', '0', '-framerate', '60',
    '-video_size', '1920x1080', '-offset_x', '0', '-offset_y', '0', '-i', 'desktop',
    '-t', '2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    ...SHARED_OUT_FLAGS,
    out,
  ]);
  if (e.code === 0 && existsSync(out)) {
    const meta = ffprobeMeta(out);
    const problem = assertMeta(meta);
    if (!problem) { pass(describeMeta(meta)); fallbackOk = true; }
    else          { fail(`${problem} — ${describeMeta(meta)}`); }
    cleanup(out);
  } else {
    fail(`gdigrab capture failed (exit ${e.code}): ${e.stderr.slice(0, 600)}`);
  }
} else {
  fail('gdigrab or libx264 missing — skipping fallback');
}

// ─── 6. summary + exit ─────────────────────────────────────────────────────────
header('summary');
console.log(`  NVENC encoder           : ${nvencEncoderOk ? 'OK' : 'FAIL'}`);
console.log(`  ddagrab + h264_nvenc    : ${primaryOk     ? 'OK (PRIMARY)'  : 'FAIL'}`);
console.log(`  gdigrab + libx264       : ${fallbackOk    ? 'OK (FALLBACK)' : 'FAIL'}`);

if (primaryOk) {
  console.log('\n→ READY: production-quality pipeline (ddagrab + h264_nvenc) verified on this machine.');
  process.exit(0);
}
if (fallbackOk) {
  console.log('\n→ DEGRADED: primary failed; fallback (gdigrab + libx264) is the best available path.');
  process.exit(1);
}
console.log('\n→ HARD STOP: no working capture path. Cannot record video on this machine.');
process.exit(2);
