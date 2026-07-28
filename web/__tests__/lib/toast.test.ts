/** @jest-environment jsdom */

/**
 * Sequential toast drain (lib/toast.ts).
 *
 * Sonner is mocked: these tests pin OUR sequencing contract — every toast
 * reaches sonner immediately (the stack visual), sonner's timer is disabled
 * via duration:Infinity, and dismissal is driven front-first, one at a time,
 * by the controller. Sonner's own Infinity handling and onDismiss semantics
 * were verified against its source (dist/index.mjs) when this was built.
 */

type AnyOpts = Record<string, unknown> & {
  duration?: number;
  onDismiss?: (t: { id: string | number }) => void;
};

const fired: Array<{ kind: string; message: unknown; opts: AnyOpts; id: number }> = [];
const dismissed: Array<string | number | undefined> = [];
let nextId = 0;

jest.mock('sonner', () => {
  const make =
    (kind: string) =>
    (message: unknown, opts: AnyOpts): number => {
      nextId += 1;
      fired.push({ kind, message, opts, id: nextId });
      return nextId;
    };
  const base = make('default') as unknown as Record<string, unknown>;
  base.success = make('success');
  base.error = make('error');
  base.info = make('info');
  base.warning = make('warning');
  base.dismiss = (id?: string | number) => {
    dismissed.push(id);
  };
  return { toast: base };
});

import { toast } from '@/lib/toast';

/** Id of the Nth toast fired IN THIS TEST (1-based) — immune to the mock's
 *  counter carrying across tests. */
function idOf(n: number): number {
  return fired[n - 1].id;
}

describe('sequential toast drain', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Drain any state left by a previous test BEFORE clearing the recorders,
    // so the dismiss-all itself isn't recorded into this test's expectations.
    toast.dismiss();
    fired.length = 0;
    dismissed.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hands every toast to sonner immediately (stack renders), with sonner timers disabled', () => {
    toast.error('one');
    toast.success('two');
    toast.info('three');

    expect(fired.map(f => f.kind)).toEqual(['error', 'success', 'info']);
    for (const f of fired) expect(f.opts.duration).toBe(Infinity);
    expect(dismissed).toEqual([]); // nothing auto-dismissed yet
  });

  it('drains front-first, one full duration at a time', () => {
    toast.error('one'); // id 1 (back of stack once others arrive)
    toast.success('two'); // id 2
    toast.info('three'); // id 3 — visual front, its clock runs

    jest.advanceTimersByTime(4_000);
    expect(dismissed).toEqual([idOf(3)]);

    jest.advanceTimersByTime(4_000);
    expect(dismissed).toEqual([idOf(3), idOf(2)]);

    jest.advanceTimersByTime(4_000);
    expect(dismissed).toEqual([idOf(3), idOf(2), idOf(1)]);
  });

  it('a user swipe on the front toast advances the drain immediately', () => {
    toast.error('one'); // id 1
    toast.success('two'); // id 2 — front

    // Simulate sonner reporting a user-initiated dismissal of the front toast.
    fired[1].opts.onDismiss?.({ id: idOf(2) });

    // The next toast now gets its own FULL duration from this moment.
    jest.advanceTimersByTime(3_999);
    expect(dismissed).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(dismissed).toEqual([idOf(1)]);
  });

  it('a new arrival becomes the front and restarts the clock', () => {
    toast.error('one'); // id 1 — front, clock running
    jest.advanceTimersByTime(3_000); // 1s left on its clock

    toast.success('two'); // id 2 — new front, full 4s

    jest.advanceTimersByTime(1_500); // old clock would have expired by now
    expect(dismissed).toEqual([]);

    jest.advanceTimersByTime(2_500); // completes the new front's 4s
    expect(dismissed).toEqual([idOf(2)]);

    // Displaced toast returns to the front and gets a FULL duration again.
    jest.advanceTimersByTime(4_000);
    expect(dismissed).toEqual([idOf(2), idOf(1)]);
  });

  it('drops an identical (kind, message) burst while it is still on screen', () => {
    toast.error('network error');
    toast.error('network error');
    toast.error('network error');
    toast.success('network error'); // different kind — kept

    expect(fired.map(f => f.kind)).toEqual(['error', 'success']);
  });

  it('respects a caller-provided duration and calls onAutoClose on controller dismissal', () => {
    const onAutoClose = jest.fn();
    toast.error('slow one', { duration: 10_000, onAutoClose });

    jest.advanceTimersByTime(9_999);
    expect(dismissed).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(dismissed).toEqual([idOf(1)]);
    expect(onAutoClose).toHaveBeenCalledTimes(1);
  });

  it('pauses the drain while the pointer is over the toaster and resumes after', () => {
    const toaster = document.createElement('div');
    toaster.setAttribute('data-sonner-toaster', 'true');
    const inner = document.createElement('div');
    toaster.appendChild(inner);
    document.body.appendChild(toaster);

    toast.error('one');

    // Enter the toaster at 1s in — 3s remain.
    jest.advanceTimersByTime(1_000);
    inner.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    jest.advanceTimersByTime(60_000); // parked under the pointer — no dismissal
    expect(dismissed).toEqual([]);

    // Leave the toaster entirely.
    inner.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    );
    jest.advanceTimersByTime(3_000);
    expect(dismissed).toEqual([idOf(1)]);

    toaster.remove();
  });
});
