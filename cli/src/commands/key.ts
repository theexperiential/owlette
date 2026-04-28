/**
 * `owlette key create | list | rotate | revoke`.
 *
 * create   POST /api/keys                        { name, scopes[], ttlDays, environment }
 * list     GET  /api/keys
 * rotate   POST /api/keys/{keyId}/rotate         { ttlDays? }
 * revoke   DELETE /api/keys/{keyId}
 *
 * Scope input modes:
 *   --preset readonly|publisher|operator|admin
 *     → uses the canonical presets from lib/apiKeyTypes.SCOPE_PRESETS
 *       (wildcard against every resource type with the preset permissions).
 *   --scope <spec> (repeatable)
 *     → spec = `<resource>=<id>:<perm>,<perm>,...`
 *       resource ∈ roost | site | machine | chat | deploy | process | user | installer
 *       id = '*' or a specific resource id
 *       perms ⊂ read | write | deploy | rollback | admin
 *     e.g. `--scope roost=rst_abc:write,deploy --scope site=site-1:read`
 *
 * `--preset` and `--scope` are mutually exclusive for create; --preset is
 * quicker for common cases, --scope gives the fine-grained control.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { isJson, renderTable as sharedRenderTable } from '../lib/output';

const VALID_RESOURCES = [
  'roost',
  'site',
  'machine',
  'chat',
  'deploy',
  'process',
  'user',
  'installer',
] as const;
const PRESET_RESOURCES = ['roost', 'site', 'machine', 'chat'] as const;
const VALID_PERMISSIONS = ['read', 'write', 'deploy', 'rollback', 'admin'] as const;
const VALID_PRESETS = ['readonly', 'publisher', 'operator', 'admin'] as const;

type Resource = (typeof VALID_RESOURCES)[number];
type Permission = (typeof VALID_PERMISSIONS)[number];
type Preset = (typeof VALID_PRESETS)[number];

interface ScopeSpec {
  resource: Resource;
  id: string;
  permissions: Permission[];
}

/* --------------------------------------------------------------------- */
/*  shared presets — kept in sync with web/lib/apiKeyTypes.SCOPE_PRESETS */
/* --------------------------------------------------------------------- */

function wildcardScopes(perms: readonly Permission[]): ScopeSpec[] {
  return PRESET_RESOURCES.map((resource) => ({
    resource,
    id: '*',
    permissions: [...perms],
  }));
}

const PRESETS: Record<Preset, ScopeSpec[]> = {
  readonly: wildcardScopes(['read']),
  publisher: wildcardScopes(['read', 'write']),
  operator: wildcardScopes(['read', 'write', 'deploy', 'rollback']),
  admin: wildcardScopes(['read', 'write', 'deploy', 'rollback', 'admin']),
};

/* --------------------------------------------------------------------- */
/*  parser: `roost=rst_abc:write,deploy` → ScopeSpec                     */
/* --------------------------------------------------------------------- */

export function parseScopeSpec(raw: string): ScopeSpec | string {
  const trimmed = raw.trim();
  const eq = trimmed.indexOf('=');
  if (eq <= 0) {
    return `scope '${raw}' must be '<resource>=<id>:<perm>[,<perm>...]'`;
  }
  const resource = trimmed.slice(0, eq).trim();
  const rest = trimmed.slice(eq + 1).trim();
  if (!VALID_RESOURCES.includes(resource as Resource)) {
    return `scope '${raw}': resource must be one of ${VALID_RESOURCES.join(', ')}`;
  }

  const colon = rest.indexOf(':');
  if (colon <= 0) {
    return `scope '${raw}' must include ':<perm>[,<perm>...]'`;
  }
  const id = rest.slice(0, colon).trim();
  const permsRaw = rest.slice(colon + 1).trim();
  if (!id) return `scope '${raw}': id is required (use '*' for wildcard)`;

  const perms = permsRaw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (perms.length === 0) {
    return `scope '${raw}': at least one permission required`;
  }
  for (const p of perms) {
    if (!VALID_PERMISSIONS.includes(p as Permission)) {
      return `scope '${raw}': '${p}' not in ${VALID_PERMISSIONS.join(', ')}`;
    }
  }
  return {
    resource: resource as Resource,
    id,
    permissions: [...new Set(perms as Permission[])],
  };
}

/* --------------------------------------------------------------------- */
/*  command registration                                                 */
/* --------------------------------------------------------------------- */

export function registerKeyCommands(program: Command): void {
  const existingKey = program.commands.find((c) => c.name() === 'key');
  if (existingKey) {
    const list = program.commands as Command[];
    const idx = list.indexOf(existingKey);
    if (idx >= 0) list.splice(idx, 1);
  }

  const key = program.command('key').description('manage api keys');

  /* -------------------- create -------------------- */

  key
    .command('create')
    .description('mint a new scoped api key (prints the raw key once)')
    .requiredOption('--name <name>', 'human-readable label for the key')
    .option(
      '--scope <spec>',
      'repeatable scope spec: `<resource>=<id>:<perm>,<perm>...` (mutually exclusive with --preset)',
      collectScope,
      [] as string[],
    )
    .option(
      '--preset <preset>',
      `canonical preset: ${VALID_PRESETS.join(' | ')} (mutually exclusive with --scope)`,
    )
    .option('--ttl-days <n>', 'lifetime in days (default 90, max 365)', '90')
    .option('--environment <env>', `'live' or 'test' (default: live)`, 'live')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) return noTokenExit();
      const json = globals.json === true;

      const scopeStrings: string[] = Array.isArray(opts.scope) ? opts.scope : [];
      const hasScopes = scopeStrings.length > 0;
      const hasPreset = typeof opts.preset === 'string';
      if (hasScopes && hasPreset) {
        return fatal('--scope and --preset are mutually exclusive — pick one');
      }
      if (!hasScopes && !hasPreset) {
        return fatal('one of --scope or --preset is required');
      }

      let scopes: ScopeSpec[];
      if (hasPreset) {
        if (!VALID_PRESETS.includes(opts.preset as Preset)) {
          return fatal(
            `--preset must be one of ${VALID_PRESETS.join(', ')}`,
          );
        }
        scopes = PRESETS[opts.preset as Preset];
      } else {
        const parsed: ScopeSpec[] = [];
        for (const s of scopeStrings) {
          const result = parseScopeSpec(s);
          if (typeof result === 'string') return fatal(result);
          parsed.push(result);
        }
        scopes = parsed;
      }

      const ttlDays = Number(opts.ttlDays);
      if (!Number.isFinite(ttlDays) || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
        return fatal('--ttl-days must be an integer between 1 and 365');
      }

      const environment = opts.environment;
      if (environment !== 'live' && environment !== 'test') {
        return fatal(`--environment must be 'live' or 'test'`);
      }

      const res = await fetch(`${apiUrl}/api/keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: opts.name,
          scopes,
          ttlDays,
          environment,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        key?: string;
        keyId?: string;
        name?: string;
        environment?: string;
        scopes?: ScopeSpec[];
        expiresAt?: number;
        keyPrefix?: string;
        detail?: string;
        error?: string;
      };
      if (!res.ok) {
        return fatal(
          `POST /api/keys failed (${res.status}): ${data.detail ?? data.error ?? JSON.stringify(data)}`,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: key created — copy it NOW, it will not be shown again.\n\n` +
          `  ${data.key}\n\n` +
          `  keyId       ${data.keyId}\n` +
          `  name        ${data.name}\n` +
          `  environment ${data.environment}\n` +
          `  expires at  ${data.expiresAt ? new Date(data.expiresAt).toISOString() : '(unknown)'}\n` +
          `  scopes      ${summariseScopes(data.scopes ?? [])}\n`,
      );
    });

  /* -------------------- list -------------------- */

  key
    .command('list')
    .description('list api keys for the authenticated user')
    .action(async (_opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) return noTokenExit();
      const json = globals.json === true;

      const res = await fetch(`${apiUrl}/api/keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        keys?: Array<{
          id: string;
          name: string | null;
          keyPrefix: string | null;
          environment: string | null;
          scopes: ScopeSpec[] | null;
          expiresAt: number | null;
          lastUsedAt: number | null;
          rotatedAt: number | null;
          revokedAt: number | null;
          expired: boolean;
          retired: boolean;
        }>;
        detail?: string;
      };
      if (!res.ok) {
        return fatal(
          `GET /api/keys failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
      }

      const keys = data.keys ?? [];
      if (json) {
        process.stdout.write(JSON.stringify({ keys }, null, 2) + '\n');
        return;
      }
      if (keys.length === 0) {
        process.stdout.write('(no keys)\n');
        return;
      }

      const rows = keys.map((k) => [
        k.id.slice(0, 12),
        k.name ?? '',
        k.environment ?? '',
        statusOf(k),
        k.expiresAt ? new Date(k.expiresAt).toISOString().slice(0, 10) : '',
        k.lastUsedAt ? new Date(k.lastUsedAt).toISOString().slice(0, 10) : 'never',
        summariseScopes(k.scopes ?? []),
      ]);
      process.stdout.write(
        renderTable(
          ['keyId', 'name', 'env', 'status', 'expires', 'last used', 'scope summary'],
          rows,
        ),
      );
    });

  /* -------------------- rotate -------------------- */

  key
    .command('rotate <keyId>')
    .description('issue a new key with the same scopes; old works for a 24h grace')
    .option('--ttl-days <n>', 'lifetime in days (default 90, max 365)', '90')
    .action(async (keyId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) return noTokenExit();
      const json = globals.json === true;

      const ttlDays = Number(opts.ttlDays);
      if (!Number.isFinite(ttlDays) || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
        return fatal('--ttl-days must be an integer between 1 and 365');
      }

      const res = await fetch(`${apiUrl}/api/keys/${encodeURIComponent(keyId)}/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttlDays }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        key?: string;
        keyId?: string;
        name?: string;
        environment?: string;
        scopes?: ScopeSpec[];
        expiresAt?: number;
        rotatedFromKeyId?: string;
        previousKey?: { keyId: string; retiresAt: number };
        detail?: string;
      };
      if (!res.ok) {
        return fatal(
          `POST /api/keys/${keyId}/rotate failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: key rotated — new key shown ONCE. old key works for 24h.\n\n` +
          `  ${data.key}\n\n` +
          `  new keyId       ${data.keyId}\n` +
          `  old keyId       ${data.rotatedFromKeyId ?? keyId}\n` +
          `  old retires at  ${data.previousKey?.retiresAt ? new Date(data.previousKey.retiresAt).toISOString() : '(unknown)'}\n` +
          `  new expires at  ${data.expiresAt ? new Date(data.expiresAt).toISOString() : '(unknown)'}\n`,
      );
    });

  /* -------------------- revoke -------------------- */

  key
    .command('revoke <keyId>')
    .description('delete an api key immediately (no grace period)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (keyId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) return noTokenExit();
      const json = globals.json === true;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `revoke key ${keyId}? this takes effect immediately, with no grace period. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('revoke cancelled\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        return fatal(
          'stdin is not a tty and --yes was not supplied; refusing to revoke silently',
        );
      }

      const res = await fetch(`${apiUrl}/api/keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        detail?: string;
      };
      if (!res.ok) {
        return fatal(
          `DELETE /api/keys/${keyId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify({ keyId, revoked: true }, null, 2) + '\n');
      } else {
        process.stdout.write(`owlette: key ${keyId} revoked\n`);
      }
    });
}

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

function collectScope(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function summariseScopes(scopes: readonly ScopeSpec[]): string {
  if (scopes.length === 0) return 'legacy (full access)';
  return scopes
    .map((s) => `${s.resource}=${s.id}:${s.permissions.join('+')}`)
    .join(' ');
}

function statusOf(k: {
  expired: boolean;
  retired: boolean;
  rotatedAt: number | null;
  revokedAt: number | null;
}): string {
  if (k.revokedAt) return 'revoked';
  if (k.expired) return 'expired';
  if (k.retired) return 'retired';
  if (k.rotatedAt) return 'rotated';
  return 'active';
}

// Delegate ascii-table rendering to the shared lib/output helper so every
// command emits byte-identical tables (makes jq/grep pipelines simpler).
const renderTable = sharedRenderTable;

async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function noTokenExit(): void {
  process.stderr.write(
    'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
  );
  process.exitCode = 2;
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** Export for tests. */
export const _internals = { parseScopeSpec, summariseScopes, statusOf, PRESETS };
