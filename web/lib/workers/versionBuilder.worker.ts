/**
 * Version builder web worker (roost wave 3.2).
 *
 * Off-main-thread execution of the chunk + SHA-256 pipeline. This file
 * is strictly the message loop; all logic lives in `../chunking.ts` so
 * Jest can exercise it without a DOM Worker.
 *
 * Wire protocol (see ../versionBuilder.ts):
 *   in:  { type: 'start', files }
 *        { type: 'abort' }
 *   out: { type: 'progress', progress }
 *        { type: 'done', entries }
 *        { type: 'error', message, name? }
 */

import { buildVersionEntries } from '../chunking';
import type {
  WorkerInbound,
  WorkerOutbound,
} from '../versionBuilder';

// `self` in a module worker is the DedicatedWorkerGlobalScope.
const ctx = self as unknown as {
  postMessage: (msg: WorkerOutbound) => void;
  addEventListener: (
    type: 'message',
    listener: (ev: { data: WorkerInbound }) => void,
  ) => void;
};

let abortController: AbortController | null = null;

ctx.addEventListener('message', (ev) => {
  const msg = ev.data;

  if (msg.type === 'abort') {
    abortController?.abort();
    return;
  }

  if (msg.type === 'start') {
    abortController = new AbortController();
    buildVersionEntries(msg.files, {
      signal: abortController.signal,
      onProgress: (progress) => {
        ctx.postMessage({ type: 'progress', progress });
      },
    })
      .then((entries) => {
        ctx.postMessage({ type: 'done', entries });
      })
      .catch((err: unknown) => {
        const e = err as { message?: string; name?: string };
        ctx.postMessage({
          type: 'error',
          message: e?.message ?? String(err),
          name: e?.name,
        });
      });
    return;
  }
});
