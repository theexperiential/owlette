/**
 * Shared output helpers used by every owlette CLI command.
 *
 * Consolidates the small primitives every command reaches for:
 *   - `isJson(cmd)` — read the global `--json` flag off a commander
 *     Command instance
 *   - `printJson(value)` — stringify + println to stdout
 *   - `printTable(headers, rows)` — ascii table with padding + a
 *     separator row; used by list / get / key list / etc.
 *   - `printLine` / `errLine` — stdout / stderr with trailing newline
 *   - `humanBytes(n)` — human-readable bytes (B / KiB / MiB / …)
 *   - `truncate(s, n)` — ellipsize long strings
 *
 * The --json envelope stays byte-identical across commands (important
 * for users piping output into `jq`).
 */

import type { Command } from 'commander';

/** True when the caller passed the global `--json` flag. */
export function isJson(cmd: Command): boolean {
  // `optsWithGlobals()` walks up the parent chain so nested sub-
  // commands pick up the root-level flag too.
  const globals = cmd.optsWithGlobals();
  return globals.json === true;
}

/** Print a value as pretty-printed JSON to stdout with a trailing newline. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** Write a line to stdout. */
export function printLine(line: string): void {
  process.stdout.write(line + '\n');
}

/** Write a line to stderr. */
export function errLine(line: string): void {
  process.stderr.write(line + '\n');
}

/** Print a local usage/validation/refusal error and mark the command as usage-failed. */
export function usageFatal(msg: string): void {
  errLine(`owlette: ${msg}`);
  process.exitCode = 2;
}

interface UnconfirmedMutationFatalInput {
  operation: string;
  idempotencyKey: string;
  cause: unknown;
}

/**
 * Surface the idempotency key after a mutating request fails before the CLI
 * receives a confirmed HTTP response.
 */
export function unconfirmedMutationFatal(input: UnconfirmedMutationFatalInput): void {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  process.stderr.write(
    `owlette: ${input.operation} did not return a confirmed response: ${detail}\n` +
      `  The request may or may not have completed.\n` +
      `  Idempotency-Key: ${input.idempotencyKey}\n` +
      `  To retry safely, re-run your original command with \`--idempotency-key ${input.idempotencyKey}\` appended.\n`,
  );
  process.exitCode = 1;
}

/**
 * ASCII table renderer: pads each column to the widest cell, draws a
 * dash separator row under the headers, preserves insertion order.
 * Empty rows render as `(no rows)` so callers don't have to special-case.
 */
export function printTable(
  headers: readonly string[],
  rows: readonly string[][],
): void {
  if (rows.length === 0) {
    printLine('(no rows)');
    return;
  }
  const widths = headers.map((h, i) => {
    const max = rows.reduce((w, r) => Math.max(w, (r[i] ?? '').length), h.length);
    return max;
  });
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').replace(/\s+$/, '');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  process.stdout.write([fmt(headers), sep, ...rows.map(fmt)].join('\n') + '\n');
}

/** Return a table as a string (used by commands that compose headers + body). */
export function renderTable(
  headers: readonly string[],
  rows: readonly string[][],
): string {
  if (rows.length === 0) return '(no rows)\n';
  const widths = headers.map((h, i) => {
    const max = rows.reduce((w, r) => Math.max(w, (r[i] ?? '').length), h.length);
    return max;
  });
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').replace(/\s+$/, '');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n') + '\n';
}

/**
 * Human-readable bytes. Values < 1024 render as `N.N B`; values in any
 * non-byte unit + < 10 get two decimals (e.g. `2.00 KiB`), ≥ 10 get
 * one decimal (`12.3 MiB`). Negative values keep their sign.
 */
export function humanBytes(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = abs;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = v < 10 && u > 0 ? 2 : 1;
  return `${sign}${v.toFixed(digits)} ${units[u]}`;
}

/** Ellipsize with a single `…` when `s` exceeds `n` chars. */
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
