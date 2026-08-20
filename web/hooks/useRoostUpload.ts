'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadFolder,
  type UploadProgress,
  type UploadResult,
} from '@/lib/roostUpload';
import type { NamedBlob } from '@/lib/chunking';

/** One upload run. Held on the hook so the minimized card can label itself without the dialog. */
export interface UploadInputs {
  siteId: string;
  roostId: string;
  /** Human-readable name shown on the /roost page. */
  name: string;
  files: NamedBlob[];
  targets: string[];
  extractPath?: string;
  /** Optional commit-message style description (≤500 chars, plaintext). */
  description?: string;
  /** Sum of file sizes. Display only. */
  totalBytes: number;
  /** Display only. */
  fileCount: number;
}

/**
 * {@link UploadProgress} plus throughput/ETA, sampled here over a sliding window so the UI can say
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
/** Minimum span (ms) before a rate estimate is trusted — avoids jitter at t=0. */
const MIN_RATE_WINDOW_MS = 3000;

interface RateSample {
  t: number;
  bytes: number;
  /** Buffer is reset on phase change — the denominator differs per phase. */
  phase: UploadProgress['phase'];
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
 * Owns upload execution outside any single component, so the dialog can be dismissed mid-flight
 * without cancelling the run. Call once at page level, pass the api into the distribution dialog,
 * and render a minimized indicator when `state.status !== 'idle'` and the dialog is closed.
 *
 * Owns the `AbortController` (on a ref, so `cancel()` survives dialog unmounts), the sliding-window
 * rate buffer, and the last `inputs` snapshot for the minimized card.
 *
 * Deliberately does NOT abort on unmount — this lives at page scope, and tab navigation cancels
 * the fetches anyway.
 */
export function useRoostUpload(): UseRoostUploadApi {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  // Ref, not state: no render per onProgress tick — throughput is folded into `progress` first.
  const samplesRef = useRef<RateSample[]>([]);
  // Guards setState from a late onProgress/resolution after unmount.
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
    // Abort any in-flight run so the hook stays safe to call imperatively without coordination.
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
        description: inputs.description,
        signal: controller.signal,
        onProgress: (p) => {
          // The lib populates BOTH fractions on the transition tick; the phase-aligned one keeps
          // the bar monotonic.
          const frac =
            p.phase === 'hashing'
              ? p.hashFraction
              : p.phase === 'uploading'
                ? p.uploadFraction
                : undefined;

          let rate: { throughputBytesPerSec?: number; etaSeconds?: number } = {};

          // Only hashing + uploading have a meaningful bytes-in-flight denominator.
          if ((p.phase === 'hashing' || p.phase === 'uploading') && frac !== undefined) {
            // Phase transitions change the denominator; keep the buffer phase-homogeneous.
            const buf = samplesRef.current;
            if (buf.length > 0 && buf[buf.length - 1].phase !== p.phase) {
              samplesRef.current = [];
            }
            // totalBytes for both phases: the real uploading denominator (post-dedup) isn't known
            // until the queue runs, and ETA only needs a per-phase-consistent denominator. Worst
            // case the uploading ETA is an upper bound, which is fine for user-facing copy.
            const denom = inputs.totalBytes;
            const bytesDone = Math.max(0, Math.min(1, frac)) * denom;
            samplesRef.current = [
              ...samplesRef.current,
              { t: Date.now(), bytes: bytesDone, phase: p.phase, totalBytes: denom },
            ].slice(-RATE_WINDOW_SAMPLES);
            rate = computeRate(samplesRef.current);
          } else if (p.phase !== 'hashing' && p.phase !== 'uploading') {
            // Leaving a rate-trackable phase; next entry starts fresh.
            samplesRef.current = [];
          }

          if (!aliveRef.current) return;
          // Latch throughput + ETA across ticks so a window that produced no new rate doesn't
          // flicker the UI off mid-upload. Phase change resets explicitly.
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
