'use client';

/**
 * useInstallerChecksum — shared checksum state for installer-authoring dialogs
 * (DeploymentDialog + SystemPresetDialog).
 *
 * Agents refuse `install_software` commands without `sha256_checksum`, so the
 * dashboard pins one at authoring time: whenever the installer URL settles on
 * a new valid https URL, the hook (debounced) POSTs it to `endpoint`, which
 * streams the binary server-side and returns its SHA-256. Manual entry covers
 * URLs the web server cannot reach (e.g. LAN-only hosts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const AUTO_COMPUTE_DEBOUNCE_MS = 800;

export type ChecksumStatus = 'idle' | 'computing' | 'ready' | 'error';

export interface InstallerChecksumState {
  sha256Checksum: string;
  checksumStatus: ChecksumStatus;
  checksumError: string;
  manualChecksum: boolean;
  /** true when `sha256Checksum` is a well-formed 64-char hex digest. */
  checksumReady: boolean;
  computeChecksum: (url: string) => Promise<void>;
  resetChecksum: () => void;
  adoptChecksum: (checksum: string | undefined, installerUrl: string) => void;
  enterManualChecksum: () => void;
  exitManualChecksum: () => void;
  setManualChecksumValue: (value: string) => void;
}

interface UseInstallerChecksumArgs {
  /** POST endpoint returning `{ sha256_checksum }` for `{ installer_url }`. */
  endpoint: string;
  /** current installer URL — watched by the debounced auto-compute effect. */
  installerUrl: string;
  /** gate for auto-compute (typically: dialog is open). */
  enabled: boolean;
}

export function useInstallerChecksum({
  endpoint,
  installerUrl,
  enabled,
}: UseInstallerChecksumArgs): InstallerChecksumState {
  const [sha256Checksum, setSha256Checksum] = useState('');
  const [checksumStatus, setChecksumStatus] = useState<ChecksumStatus>('idle');
  const [checksumError, setChecksumError] = useState('');
  const [manualChecksum, setManualChecksum] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastComputedUrlRef = useRef('');

  const resetChecksum = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastComputedUrlRef.current = '';
    setSha256Checksum('');
    setChecksumStatus('idle');
    setChecksumError('');
    setManualChecksum(false);
  }, []);

  const computeChecksum = useCallback(async (url: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastComputedUrlRef.current = url;
    setChecksumStatus('computing');
    setChecksumError('');
    setSha256Checksum('');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installer_url: url }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `failed to compute checksum (${response.status})`;
        try {
          const body = await response.json();
          detail = body.detail ?? body.title ?? detail;
        } catch { /* non-JSON error body */ }
        throw new Error(detail);
      }
      const result = await response.json();
      setSha256Checksum(result.sha256_checksum);
      setChecksumStatus('ready');
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      lastComputedUrlRef.current = '';
      setChecksumStatus('error');
      setChecksumError(error instanceof Error ? error.message : String(error));
    }
  }, [endpoint]);

  /** Adopt a stored checksum from a template/preset, or clear for recompute. */
  const adoptChecksum = useCallback((checksum: string | undefined, url: string) => {
    abortRef.current?.abort();
    setManualChecksum(false);
    setChecksumError('');
    if (checksum && SHA256_HEX_RE.test(checksum.toLowerCase())) {
      setSha256Checksum(checksum.toLowerCase());
      setChecksumStatus('ready');
      lastComputedUrlRef.current = url;
    } else {
      // Legacy doc saved before checksums existed — the auto-compute effect
      // recomputes from its URL and the next save self-heals the doc.
      setSha256Checksum('');
      setChecksumStatus('idle');
      lastComputedUrlRef.current = '';
    }
  }, []);

  const enterManualChecksum = useCallback(() => {
    abortRef.current?.abort();
    setManualChecksum(true);
    setSha256Checksum('');
    setChecksumStatus('idle');
    setChecksumError('');
  }, []);

  const exitManualChecksum = useCallback(() => {
    setManualChecksum(false);
    lastComputedUrlRef.current = '';
    setSha256Checksum('');
    setChecksumStatus('idle');
  }, []);

  const setManualChecksumValue = useCallback((value: string) => {
    const normalized = value.trim().toLowerCase();
    setSha256Checksum(normalized);
    setChecksumStatus(SHA256_HEX_RE.test(normalized) ? 'ready' : 'idle');
  }, []);

  // Auto-compute (debounced) whenever the installer URL settles on a new
  // valid https URL. Skipped in manual mode and when the checksum for this
  // exact URL is already known (template/preset selection pre-fills it).
  useEffect(() => {
    if (!enabled || manualChecksum) return;
    const url = installerUrl.trim();
    let validHttps = false;
    try {
      validHttps = new URL(url).protocol === 'https:';
    } catch { /* incomplete URL while typing */ }
    if (!validHttps) return;
    if (url === lastComputedUrlRef.current) return;

    const timer = setTimeout(() => { void computeChecksum(url); }, AUTO_COMPUTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [installerUrl, enabled, manualChecksum, computeChecksum]);

  // Cancel any in-flight compute on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    sha256Checksum,
    checksumStatus,
    checksumError,
    manualChecksum,
    checksumReady: SHA256_HEX_RE.test(sha256Checksum),
    computeChecksum,
    resetChecksum,
    adoptChecksum,
    enterManualChecksum,
    exitManualChecksum,
    setManualChecksumValue,
  };
}
