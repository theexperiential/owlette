/**
 * `roost auth login | status | logout` — wave 4.2.
 *
 * login: kicks off the cli device-code flow against `/api/cli/device-code`,
 *        prints the pairing phrase + verification URL, polls until
 *        authorised, and writes the returned owk_* key to the active
 *        profile in ~/.config/roost/config.toml.
 * status: calls GET /api/whoami with the configured token and prints
 *         the server-resolved identity + scope + quota summary.
 * logout: removes the token from the active profile in config.toml.
 */

import { Command } from 'commander';
import { exec } from 'child_process';
import { platform } from 'os';
import {
  DEFAULT_API_URL,
  _resetConfigCache,
  defaultConfigPath,
  loadConfig,
} from '../config';
import { writeTokenToConfig, clearTokenFromConfig } from '../configWriter';

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;

interface DeviceCodeResponse {
  pairPhrase: string;
  deviceCode: string;
  verificationUri: string;
  pairingUrl: string;
  expiresIn: number;
  interval: number;
}

interface PollAuthorizedResponse {
  apiKey: string;
  keyId: string;
  name: string | null;
  scopes: unknown;
  environment: 'live' | 'test' | null;
  expiresAt: number | null;
  siteId: string | null;
}

function tryOpenBrowser(url: string): void {
  const p = platform();
  const cmd =
    p === 'win32' ? `start "" "${url}"` : p === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try {
    exec(cmd, () => {
      /* best-effort — ignore errors; the user has the url to copy-paste */
    });
  } catch {
    /* ignore */
  }
}

async function post<T>(
  apiUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('authenticate with the roost api');

  auth
    .command('login')
    .description('start the device-code flow and store the issued api key')
    .option(
      '--no-browser',
      'skip the automatic browser open — print the url and let the user copy it',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, profile, configPath } = loadConfig({
        profile: cmd.optsWithGlobals().profile,
      });

      process.stdout.write(`roost: requesting device code from ${apiUrl}\n`);
      const startRes = await post<DeviceCodeResponse>(apiUrl, '/api/cli/device-code', {});
      if (startRes.status !== 200) {
        process.stderr.write(
          `roost: failed to obtain device code (${startRes.status}): ${JSON.stringify(
            startRes.data,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const { pairPhrase, deviceCode, pairingUrl, interval, expiresIn } = startRes.data;
      const pollMs = Math.max(interval * 1000, POLL_INTERVAL_MS);

      process.stdout.write('\n');
      process.stdout.write(`  pairing phrase : ${pairPhrase}\n`);
      process.stdout.write(`  verification   : ${pairingUrl}\n`);
      process.stdout.write(`  expires in     : ${expiresIn}s\n`);
      process.stdout.write('\n');

      if (opts.browser !== false) {
        process.stdout.write('roost: opening the verification url in your browser…\n');
        tryOpenBrowser(pairingUrl);
      } else {
        process.stdout.write('roost: open the url above in your browser to continue.\n');
      }

      const deadline = Date.now() + Math.min(expiresIn * 1000, MAX_POLL_DURATION_MS);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const pollRes = await post<PollAuthorizedResponse & { status?: string; error?: string }>(
          apiUrl,
          '/api/cli/device-code/poll',
          { deviceCode },
        );
        if (pollRes.status === 202) {
          process.stdout.write('.');
          continue;
        }
        if (pollRes.status === 200 && pollRes.data.apiKey) {
          process.stdout.write('\nroost: authorised — storing key…\n');
          const writeOpts: Parameters<typeof writeTokenToConfig>[0] = {
            configPath: configPath ?? defaultConfigPath(),
            profile,
            token: pollRes.data.apiKey,
          };
          if (apiUrl !== DEFAULT_API_URL) writeOpts.apiUrl = apiUrl;
          if (pollRes.data.environment) writeOpts.environment = pollRes.data.environment;
          const written = writeTokenToConfig(writeOpts);
          _resetConfigCache();
          process.stdout.write(
            `roost: stored key in profile '${profile}' at ${written}\n`,
          );
          if (pollRes.data.keyId) {
            process.stdout.write(`       keyId: ${pollRes.data.keyId}\n`);
          }
          if (pollRes.data.name) {
            process.stdout.write(`       name : ${pollRes.data.name}\n`);
          }
          return;
        }
        if (pollRes.status === 410) {
          process.stderr.write('\nroost: pairing phrase expired; re-run `roost auth login`.\n');
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          `\nroost: unexpected poll response (${pollRes.status}): ${JSON.stringify(
            pollRes.data,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write('\nroost: timed out waiting for authorisation.\n');
      process.exitCode = 1;
    });

  auth
    .command('status')
    .description('call /api/whoami and print the server-resolved identity')
    .action(async (_opts, cmd) => {
      const { apiUrl, token, profile, environment, configPath } = loadConfig({
        profile: cmd.optsWithGlobals().profile,
      });
      if (!token) {
        process.stderr.write(
          'roost: no token configured. set ROOST_TOKEN or run `roost auth login`.\n',
        );
        process.exitCode = 2;
        return;
      }
      try {
        const res = await fetch(`${apiUrl}/api/whoami`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          process.stderr.write(
            `roost: whoami failed (${res.status}): ${JSON.stringify(data)}\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          JSON.stringify(
            {
              apiUrl,
              profile,
              configPath,
              environment,
              whoami: data,
            },
            null,
            2,
          ) + '\n',
        );
      } catch (err) {
        process.stderr.write(`roost: whoami request failed: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  auth
    .command('logout')
    .description('clear the stored token from the active profile')
    .action(async (_opts, cmd) => {
      const { profile, configPath } = loadConfig({
        profile: cmd.optsWithGlobals().profile,
      });
      const target = configPath ?? defaultConfigPath();
      const cleared = clearTokenFromConfig({ configPath: target, profile });
      _resetConfigCache();
      if (cleared) {
        process.stdout.write(`roost: cleared token from profile '${profile}' at ${target}\n`);
      } else {
        process.stdout.write(
          `roost: profile '${profile}' had no stored token (nothing to clear).\n`,
        );
      }
    });
}
