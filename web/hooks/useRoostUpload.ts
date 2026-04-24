'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadFolder,
  type UploadProgress,
  type UploadResult,
} from '@/lib/roostUpload';
import type { NamedBlob } from '@/lib/chunking';

/**
 * Inputs for a single roost upload run. Kept on the hook so the
 * minimized-card surface can render contextual labels (name, file count,
 * total bytes) without re-asking the dialog for them.
 */
export interface UploadInputs {
  siteId: string;
  roostId: string;
  /** Human-readable name shown on the /roost page. */
  name: string;
  files: NamedBlob[];
  targets: string[];
  extractPath?: string;
  /** Pre-computed total bytes (sum of file sizes). Used for display only. */
  totalBytes: number;
  /** Pre-computed file count. Used for display only. */
  fileCount: number;
}

/**
 * Progress augmented with hook-computed throughput + ETA. The underlying
 * {@link UploadProgress} from roostUpload exposes phase + fractions; we
 * sample them here over a short sliding window so the UI can show
 * "~2m 14s remaining" without plumbing timing into the core pipeline.
 */
export interface ProgressWithRate extends UploadProgress {
  /** Bytes/sec for the active phase, or `undefined` if not yet measurable. */
  throughputBytesPerSec?: number;
  /** Seconds remaining for the active phase, or `undefined` if not yet measurable. */
  etaSeconds?: number;
}

export type UploadStatus =
  | 'idle'
  | 'uploading'
  | 'success'
  | 'error'
  | 'cancelled';

export interface UploadState {
  status: UploadStatus;
  progress?: ProgressWithRate;
  inputs?: UploadInputs;
  result?: UploadResult;
  error?: string;
}

export interface UseRoostUploadApi {
  state: UploadState;
  /** Kick off an upload. Aborts and replaces any in-flight run. */
  start: (inputs: UploadInputs) => Promise<void>;
  /** Abort the in-flight upload, if any. */
  cancel: () => void;
  /** Reset back to `idle`. Safe to call any time (also aborts). */
  reset: () => void;
}

/** Max samples retained for the rate ring-buffer. */
const RATE_WINDOW_SAMPLES = 8;
/** Minimum span (ms) before we trust a rate estimate — avoids jitter at t=0. */
const MIN_RATE_WINDOW_MS = 3000;

interface RateSample {
  t: number;
  bytes: number;
  /** Which bytes this sample belongs to — we reset the buffer on phase change. */
  phase: UploadProgress['phase'];
  /** Denominator for this phase (hashing = sum of file sizes; uploading = bytes to upload). */
  totalBytes: number;
}

function computeRate(
  samples: readonly RateSample[],
): { throughputBytesPerSec?: number; etaSeconds?: number } {
  if (samples.length < 2) return {};
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const dt = newest.t - oldest.t;
  if (dt < MIN_RATE_WINDOW_MS) return {};
  const dBytes = newest.bytes - oldest.bytes;
  if (dBytes <= 0) return {};
  const rate = dBytes / (dt / 1000); // bytes / sec
  if (!isFinite(rate) || rate <= 0) return {};
  const remaining = Math.max(0, newest.totalBytes - newest.bytes);
  const etaSeconds = remaining > 0 ? remaining / rate : 0;
  return { throughputBytesPerSec: rate, etaSeconds };
}

/**
 * Lift the roost upload execution out of any single component so the
 * dialog can be dismissed mid-flight without cancelling the run.
 *
 * Usage: call at the page level once, pass the returned api down to the
 * distribution dialog, and render a minimized indicator at the page when
 * `state.status !== 'idle'` and the dialog is closed.
 *
 * The hook owns:
 *   - the `AbortController` (so `cancel()` actually works across dialog
 *     unmounts; the controller lives on a ref and outlives renders)
 *   - the sliding-window rate buffer that powers throughput + ETA
 *   - the last-known `inputs` snapshot so the minimized card can display
 *     the roost name without reaching back into the dialog's state
 *
 * On unmount we deliberately do NOT abort — the hook is expected to live
 * at page scope, not inside a transient dialog. If something higher up
 * unmounts the whole page, the browser tab navigation cancels fetches
 * naturally.
 */
export function useRoostUpload(): UseRoostUploadApi {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  // Ring buffer for rate samples. Ref'd (not state) because we don't want
  // a render per onProgress tick — the throughput is folded into `progress`
  // before setState so a single render carries both.
  const samplesRef = useRef<RateSample[]>([]);
  // Tracks whether the hook has been unmounted, so a late onProgress/
  // resolution from the background fetch doesn't call setState on a dead
  // tree and leak an in-memory update.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    samplesRef.current = [];
    if (!aliveRef.current) return;
    setState({ status: 'idle' });
  }, []);

  const start = useCallback(async (inputs: UploadInputs) => {
    // If something is already in flight, abort it before kicking off a
    // replacement. The caller (the dialog) already guards against this
    // in practice, but defending here keeps the hook safe to call
    // imperatively without coordination.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    samplesRef.current = [];

    setState({
      status: 'uploading',
      inputs,
      progress: { phase: 'idle' },
    });

    try {
      const result = await uploadFolder({
        siteId: inputs.siteId,
        roostId: inputs.roostId,
        files: inputs.files,
        name: inputs.name,
        targets: inputs.targets,
        extractPath: inputs.extractPath,
        signal: controller.signal,
        onProgress: (p) => {
          // Pick the fraction for the active phase. The lib sometimes
          // populates BOTH fractions on the transition tick; using the
          // phase-aligned one keeps the bar monotonic.
          const frac =
            p.phase === 'hashing'
              ? p.hashFraction
              : p.phase === 'uploading'
                ? p.uploadFraction
                : undefined;

          let rate: { throughputBytesPerSec?: number; etaSeconds?: number } = {};

          // Only hashing + uploading have a meaningful bytes-in-flight denominator.
          // checking/finalizing/idle/done/error skip rate computation.
          if ((p.phase === 'hashing' || p.phase === 'uploading') && frac !== undefined) {
            // Phase transitions invalidate older samples (different
            // denominator). Keep the buffer phase-homogeneous.
            const buf = samplesRef.current;
            if (buf.length > 0 && buf[buf.length - 1].phase !== p.phase) {
              samplesRef.current = [];
            }
            // Denominator: hashing counts every dropped byte; uploading
            // only counts the missing (post-dedup) bytes. We don't know
            // the uploading denominator until the queue runs, so we use
            // the fraction to back it out from a known delta — simpler
            // approach is to use totalBytes when hashing, and scale by
            // fraction for uploading against the totalBytes baseline.
            //
            // For ETA purposes we only need *a* consistent denominator
            // per-phase; using totalBytes for both phases keeps rate
            // computation self-consistent even if the upload denominator
            // is smaller (post-dedup) — the ETA will just be an upper
            // bound for uploading, which is fine for user-facing copy.
            const denom = inputs.totalBytes;
            const bytesDone = Math.max(0, Math.min(1, frac)) * denom;
            samplesRef.current = [
              ...samplesRef.current,
              { t: Date.now(), bytes: bytesDone, phase: p.phase, totalBytes: denom },
            ].slice(-RATE_WINDOW_SAMPLES);
            rate = computeRate(samplesRef.current);
          } else if (p.phase !== 'hashing' && p.phase !== 'uploading') {
            // Leaving a rate-trackable phase — drop the buffer so next
            // entry into hashing/uploading starts fresh.
            samplesRef.current = [];
          }

          if (!aliveRef.current) return;
          // Latch throughput + ETA across ticks: if this sample window
          // didn't produce a new rate (too short, zero byte delta, etc.),
          // keep the previous values so the UI doesn't flicker on/off
          // while a slow upload plods along. Phase change resets explicitly.
          setState((prev) => {
            const prevProgress = prev.progress;
            const phaseChanged = prevProgress?.phase !== p.phase;
            const throughputBytesPerSec =
              rate.throughputBytesPerSec
              ?? (phaseChanged ? undefined : prevProgress?.throughputBytesPerSec);
            const etaSeconds =
              rate.etaSeconds
              ?? (phaseChanged ? undefined : prevProgress?.etaSeconds);
            return {
              ...prev,
              status: 'uploading',
              progress: { ...p, throughputBytesPerSec, etaSeconds },
            };
          });
        },
      });

      if (!aliveRef.current) return;
      setState({
        status: 'success',
        inputs,
        result,
        progress: { phase: 'done' },
      });
    } catch (err) {
      if (!aliveRef.current) return;
      const aborted =
        err instanceof Error &&
        (err.name === 'AbortError' || /abort|cancel/i.test(err.message));
      const message = err instanceof Error ? err.message : String(err);
      setState({
        status: aborted ? 'cancelled' : 'error',
        inputs,
        error: aborted ? 'upload cancelled' : message,
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  return { state, start, cancel, reset };
}
