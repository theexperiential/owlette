/**
 * `owlette whoami` — print the server-resolved identity for the active
 * profile.
 *
 * Drives:
 *   GET /api/whoami
 *
 * Renders a key/value summary by default (user id, email, scopes,
 * environment, apiUrl, profile, configPath, credentialSource) and emits the same JSON
 * envelope `owlette auth status` historically produced
 * (`{ apiUrl, profile, configPath, credentialSource, environment, whoami: <raw response> }`)
 * when `--json` is passed.
 *
 * `runWhoami` is exported and reused by the `auth status` action so
 * both commands produce byte-identical stdout/stderr.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { errLine, isJson, printJson, printLine } from '../lib/output';

interface ApiKeyScopeLite {
  resource: string;
  id: string;
  permissions: string[];
}

interface WhoamiResponse {
  userId: string;
  email: string | null;
  role: string | null;
  key: {
    keyId: string | null;
    name: string | null;
    keyPrefix: string | null;
    scopes: ApiKeyScopeLite[] | null;
    environment: string | null;
    expiresAt: number | null;
    lastUsedAt: number | null;
    isLegacy: boolean;
  } | null;
  rateLimit: unknown;
  quota: unknown;
  primarySiteId: string | null;
}

/**
 * Shared implementation for `owlette whoami` and `owlette auth status`.
 * Reads the active profile, calls GET /api/whoami, and writes the
 * response in either table or JSON form.
 *
 * Exit codes:
 *   2 — no token configured
 *   1 — request failed (non-2xx response or network error)
 */
export async function runWhoami(cmd: Command): Promise<void> {
  const {
    apiUrl,
    token,
    profile,
    environment,
    configPath,
    credentialPath,
    credentialSource,
  } = loadConfig({
    profile: cmd.optsWithGlobals().profile,
  });
  if (!token) {
    errLine('owlette: no token configured. set OWLETTE_TOKEN or run `owlette auth login`.');
    process.exitCode = 2;
    return;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiUrl}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    errLine(`owlette: whoami request failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    errLine(`owlette: whoami failed (${res.status}): ${JSON.stringify(data)}`);
    process.exitCode = 1;
    return;
  }

  if (isJson(cmd)) {
    printJson({
      apiUrl,
      profile,
      configPath,
      credentialPath,
      credentialSource,
      environment,
      whoami: data,
    });
    return;
  }

  printLine(
    formatWhoami(data as unknown as WhoamiResponse, {
      apiUrl,
      profile,
      environment,
      configPath,
      credentialPath,
      credentialSource,
    }),
  );
}

/** Register `owlette whoami` against the root program. */
export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('print server-resolved identity + scopes')
    .action(async (_opts, cmd) => {
      await runWhoami(cmd);
    });
}

/* --------------------------------------------------------------------- */
/*  formatter                                                            */
/* --------------------------------------------------------------------- */

interface LocalContext {
  apiUrl: string;
  profile: string;
  environment: 'live' | 'test' | null;
  configPath: string | null;
  credentialPath: string | null;
  credentialSource: 'env' | 'keychain' | 'token-file' | 'config' | null;
}

function formatWhoami(w: WhoamiResponse, ctx: LocalContext): string {
  const out: string[] = [];
  out.push(`user id     ${w.userId}`);
  out.push(`email       ${w.email ?? '(unknown)'}`);
  out.push(`scopes      ${summarizeScopes(w.key)}`);
  out.push(`environment ${ctx.environment ?? w.key?.environment ?? '(unset)'}`);
  out.push(`apiUrl      ${ctx.apiUrl}`);
  out.push(`profile     ${ctx.profile}`);
  out.push(`configPath  ${ctx.configPath ?? '(no config file)'}`);
  out.push(`credential  ${formatCredential(ctx)}`);
  return out.join('\n');
}

function formatCredential(ctx: LocalContext): string {
  if (!ctx.credentialSource) return '(none)';
  if (ctx.credentialSource === 'token-file') {
    return `${ctx.credentialSource} ${ctx.credentialPath ?? '(unknown path)'}`;
  }
  if (ctx.credentialSource === 'config') return 'config.toml (legacy)';
  return ctx.credentialSource;
}

function summarizeScopes(key: WhoamiResponse['key']): string {
  if (!key) return '(session auth — no api key)';
  if (key.isLegacy) return '(legacy key — full access, no scope list)';
  const scopes = key.scopes ?? [];
  if (scopes.length === 0) return '(none)';
  return scopes
    .map((s) => `${s.resource}:${s.id}=${(s.permissions ?? []).join('|') || '(none)'}`)
    .join(', ');
}

/** Exported for unit tests. */
export const _internals = { formatWhoami, summarizeScopes, formatCredential };
