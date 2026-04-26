/**
 * `owlette version`.
 *
 * Drives:
 *   GET /api/version
 *
 * Prints the cli's own package version alongside the server's current
 * dated api-version + the full list of accepted `Roost-Version` values.
 * Default output (one line):
 *
 *     cli X.Y.Z  |  server A.B.C  |  supported versions: D1, D2, ...
 *
 * `--json` emits the full record so scripts can compare without parsing.
 *
 * Pinning: `--api-version YYYY-MM-DD` is forwarded as the `Roost-Version`
 * request header. The endpoint itself accepts any value here (it's the
 * version catalog — clients probe it before they know what the server
 * supports), but if the pinned date is older than the oldest entry in
 * `supported[]` we emit a warning to stderr so the operator knows their
 * other requests are likely to be rejected with `unsupported_version`.
 *
 * The endpoint is unauthenticated, so a missing token is not fatal.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { isJson } from '../lib/output';

/**
 * Resolve the cli's own package version by walking up from this file
 * until we hit a `package.json`. Works identically whether we're running
 * from `src/` (ts-node, dev) or `dist/` (compiled, prod) because both
 * tree shapes share the same nearest-package.json ancestor (`cli/`).
 */
let cachedCliVersion: string | null = null;
function readCliVersion(): string {
  if (cachedCliVersion !== null) return cachedCliVersion;
  let dir = __dirname;
  // Hard cap on traversal depth so a misconfigured install can't loop
  // forever (`/` keeps returning itself from `dirname`).
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    try {
      const raw = readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === '@owlette/cli' && typeof parsed.version === 'string') {
        cachedCliVersion = parsed.version;
        return cachedCliVersion;
      }
    } catch {
      // not this directory; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedCliVersion = 'unknown';
  return cachedCliVersion;
}

interface VersionResponse {
  current: string;
  supported: string[];
}

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('print cli + server versions')
    .option(
      '--api-version <YYYY-MM-DD>',
      'pin the Roost-Version header sent with this request',
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });

      const pinned: string | null =
        typeof opts.apiVersion === 'string' && opts.apiVersion.trim() !== ''
          ? opts.apiVersion.trim()
          : null;

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (pinned) headers['Roost-Version'] = pinned;

      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/version`, { headers });
      } catch (err) {
        fatal(`GET /api/version failed: ${(err as Error).message}`);
        return;
      }

      const data = (await res.json().catch(() => ({}))) as Partial<VersionResponse> & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(`GET /api/version failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      const serverCurrent = typeof data.current === 'string' ? data.current : '';
      const supported = Array.isArray(data.supported)
        ? data.supported.filter((v): v is string => typeof v === 'string')
        : [];

      if (!serverCurrent || supported.length === 0) {
        fatal('GET /api/version returned an unexpected shape');
        return;
      }

      // Lex order on YYYY-MM-DD == chronological order, so min == oldest.
      const minimumVersion = [...supported].sort()[0] ?? serverCurrent;

      if (pinned && pinned < minimumVersion) {
        process.stderr.write(
          `owlette: warning — pinned api-version ${pinned} is older than ` +
            `server minimum ${minimumVersion}; some endpoints may reject your requests\n`,
        );
      }

      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              cli: readCliVersion(),
              server: serverCurrent,
              supportedVersions: supported,
              minimumVersion,
              pinned,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      process.stdout.write(
        `cli ${readCliVersion()}  |  server ${serverCurrent}  |  ` +
          `supported versions: ${supported.join(', ')}\n`,
      );
    });
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}
