/**
 * `owlette auth login | status | logout`.
 *
 * login: kicks off the cli device-code flow against `/api/cli/device-code`,
 *        prints the pairing phrase + verification URL, polls until
 *        authorised, and stores the returned owk_* key in the active
 *        profile's credential store.
 * status: calls GET /api/whoami with the configured token and prints
 *         the server-resolved identity + scope + quota summary.
 * logout: removes the token from the active profile's credential store.
 */

import { Command } from 'commander';
import { exec } from 'child_process';
import { platform } from 'os';
import {
  _resetConfigCache,
  defaultConfigPath,
  loadConfig,
} from '../config';
import { clearTokenFromConfig, writeProfileConfig } from '../configWriter';
import {
  clearStoredCredential,
  defaultCredentialPath,
  writeStoredCredential,
  type WriteCredentialResult,
} from '../credentialStore';
import { runWhoami } from './whoami';

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

function describeCredentialLocation(result: WriteCredentialResult): string {
  if (result.source === 'keychain') return 'OS keychain';
  return result.credentialPath ?? 'token file';
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
  const auth = program.command('auth').description('authenticate with the owlette api');

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

      process.stdout.write(`owlette: requesting device code from ${apiUrl}\n`);
      const startRes = await post<DeviceCodeResponse>(apiUrl, '/api/cli/device-code', {});
      if (startRes.status !== 200) {
        process.stderr.write(
          `owlette: failed to obtain device code (${startRes.status}): ${JSON.stringify(
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
        process.stdout.write('owlette: opening the verification url in your browser…\n');
        tryOpenBrowser(pairingUrl);
      } else {
        process.stdout.write('owlette: open the url above in your browser to continue.\n');
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
          process.stdout.write('\nowlette: authorised — storing credential...\n');
          const targetConfigPath = configPath ?? defaultConfigPath();
          const credentialPath = defaultCredentialPath(targetConfigPath);
          const credentialOpts: Parameters<typeof writeStoredCredential>[0] = {
            credentialPath,
            profile,
            token: pollRes.data.apiKey,
            apiUrl,
          };
          if (pollRes.data.environment) {
            credentialOpts.environment = pollRes.data.environment;
          }
          const storedCredential = writeStoredCredential(credentialOpts);

          const profileOpts: Parameters<typeof writeProfileConfig>[0] = {
            configPath: targetConfigPath,
            profile,
            apiUrl,
          };
          if (pollRes.data.environment) profileOpts.environment = pollRes.data.environment;
          const writtenProfile = writeProfileConfig(profileOpts);
          clearTokenFromConfig({ configPath: targetConfigPath, profile });

          _resetConfigCache();
          process.stdout.write(
            `owlette: stored credential for profile '${profile}' in ${describeCredentialLocation(
              storedCredential,
            )}\n`,
          );
          process.stdout.write(`       profile metadata: ${writtenProfile}\n`);
          if (pollRes.data.keyId) {
            process.stdout.write(`       keyId: ${pollRes.data.keyId}\n`);
          }
          if (pollRes.data.name) {
            process.stdout.write(`       name : ${pollRes.data.name}\n`);
          }
          return;
        }
        if (pollRes.status === 410) {
          process.stderr.write('\nowlette: pairing phrase expired; re-run `owlette auth login`.\n');
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          `\nowlette: unexpected poll response (${pollRes.status}): ${JSON.stringify(
            pollRes.data,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write('\nowlette: timed out waiting for authorisation.\n');
      process.exitCode = 1;
    });

  auth
    .command('status')
    .description('alias of `owlette whoami` — print server-resolved identity + scopes')
    .action(async (_opts, cmd) => {
      await runWhoami(cmd);
    });

  auth
    .command('logout')
    .description('clear the stored credential from the active profile')
    .action(async (_opts, cmd) => {
      const { profile, configPath, credentialPath } = loadConfig({
        profile: cmd.optsWithGlobals().profile,
      });
      const targetConfigPath = configPath ?? defaultConfigPath();
      const targetCredentialPath = credentialPath ?? defaultCredentialPath(targetConfigPath);
      const clearedCredential = clearStoredCredential({
        credentialPath: targetCredentialPath,
        profile,
      });
      const clearedConfig = clearTokenFromConfig({ configPath: targetConfigPath, profile });
      _resetConfigCache();
      if (clearedCredential || clearedConfig) {
        process.stdout.write(`owlette: cleared stored credential for profile '${profile}'\n`);
      } else {
        process.stdout.write(
          `owlette: profile '${profile}' had no stored credential (nothing to clear).\n`,
        );
      }
      if (process.env.OWLETTE_TOKEN) {
        process.stdout.write('owlette: OWLETTE_TOKEN is still set and will continue to authenticate.\n');
      }
    });
}
