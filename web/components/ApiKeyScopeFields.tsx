'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, Plus, X } from 'lucide-react';
import {
  ALL_RESOURCES,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  type ApiKeyScopePreset,
  SCOPE_PRESET_DESCRIPTIONS,
  SCOPE_PRESET_KEYS,
  SCOPE_PRESET_LABELS,
  SCOPE_PRESETS,
  SCOPE_RESOURCE_LABELS,
  SUPERADMIN_ONLY_RESOURCES,
} from '@/lib/apiKeyTypes';

/**
 * The scope builder, shared by create and edit.
 *
 * It used to render a preset dropdown and nothing else, hiding twenty
 * checkboxes behind a "custom" option in that same dropdown — so the screen
 * carried no rendering at all of what a key actually grants, and the only
 * route to the `installer`, `deploy`, `process` and `user` resources (which no
 * preset covers) was to guess that "custom" existed. The grid is now always
 * mounted and always editable; presets write into it rather than replacing it.
 *
 * That also removes a data-loss bug by construction. The old component held
 * two sources of truth — a `preset` and a `customScopes` array — and every
 * writer for the second lived inside the `preset === 'custom'` branch, so they
 * could never reconcile: picking `operator` and then `custom` silently dropped
 * 14 of 16 grants. There is one array now, so there is no transition across
 * which anything can be lost.
 *
 * Layout is container-query driven, not viewport driven. This panel renders
 * both on /settings/api-keys (~800px of content box) and inside the
 * account-settings dialog, whose w-48 sidebar and nested padding leave ~320px
 * at a 640px viewport — after `sm:` has already fired. A media query cannot
 * tell those apart.
 */

export type ScopeSelection = ApiKeyScopePreset | 'custom';

/** Canonical order. Serialization follows it so a ticking order never changes the wire array. */
const PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];

const PERM_INDEX = new Map<ApiKeyPermission, number>(PERMISSIONS.map((p, i) => [p, i]));

/** Resources anyone may grant — one permanent row each. */
const BASE_RESOURCES: readonly ApiKeyResource[] = ALL_RESOURCES.filter(
  (r) => !SUPERADMIN_ONLY_RESOURCES.includes(r),
);
/** Platform-wide resources; superadmin-only at the server, so gated in the UI too. */
const PLATFORM_RESOURCES: readonly ApiKeyResource[] = SUPERADMIN_ONLY_RESOURCES;

function sortPermissions(ps: ApiKeyPermission[]): ApiKeyPermission[] {
  return [...new Set(ps)].sort((a, b) => PERM_INDEX.get(a)! - PERM_INDEX.get(b)!);
}

export interface ScopeRow {
  resource: ApiKeyResource;
  /** '*' on a base row; a concrete id on a specific row. */
  id: string;
  permissions: ApiKeyPermission[];
  /**
   * base: fixed per-resource wildcard row — static label, id locked to '*', not removable.
   * specific: user-added — resource select, editable id, removable.
   * locked: a superadmin-only grant the current viewer cannot re-grant. Read-only,
   *   excluded from serialization, and disclosed by a banner.
   */
  kind: 'base' | 'specific' | 'locked';
}

function sameScopes(a: ApiKeyScope[], b: ApiKeyScope[]): boolean {
  if (a.length !== b.length) return false;
  const fingerprint = (s: ApiKeyScope) =>
    `${s.resource}:${s.id}:${[...s.permissions].sort().join(',')}`;
  const left = a.map(fingerprint).sort();
  const right = b.map(fingerprint).sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * Which preset a scope set corresponds to, or 'custom'.
 *
 * This drives the live pressed-state of the preset chips on every edit, so a
 * set that happens to match `operator` says so no matter how it was reached.
 */
export function presetForScopes(scopes: ApiKeyScope[] | null): ScopeSelection {
  if (!scopes || scopes.length === 0) return 'custom';
  for (const key of SCOPE_PRESET_KEYS) {
    if (sameScopes(scopes, SCOPE_PRESETS[key])) return key;
  }
  return 'custom';
}

/**
 * Hydrate the editable grid from a stored scope list.
 *
 * Handles null internally — a legacy key with no scopes is exactly the null
 * case, and it yields an all-empty grid rather than a pre-ticked guess, so
 * saving cannot silently narrow a full-access credential to one arbitrary row.
 */
export function buildScopeRows(
  scopes: ApiKeyScope[] | null,
  canGrantPlatformScopes: boolean,
): ScopeRow[] {
  const rows: ScopeRow[] = BASE_RESOURCES.map((resource) => ({
    resource,
    id: '*',
    permissions: [],
    kind: 'base' as const,
  }));
  if (canGrantPlatformScopes) {
    for (const resource of PLATFORM_RESOURCES) {
      rows.push({ resource, id: '*', permissions: [], kind: 'base' });
    }
  }

  for (const scope of scopes ?? []) {
    const permissions = sortPermissions(scope.permissions);
    if (scope.id === '*') {
      const base = rows.find((r) => r.kind === 'base' && r.resource === scope.resource);
      if (base) {
        base.permissions = permissions;
      } else {
        // A platform grant held by someone who can no longer grant it.
        rows.push({ resource: scope.resource, id: '*', permissions, kind: 'locked' });
      }
      continue;
    }
    const at = rows.findIndex((r) => r.kind === 'base' && r.resource === scope.resource);
    const row: ScopeRow = {
      resource: scope.resource,
      id: scope.id,
      permissions,
      kind: 'specific',
    };
    if (at === -1) rows.push(row);
    else rows.splice(at + 1, 0, row);
  }

  return rows;
}

/** The grid, as the API takes it. What is displayed is what is submitted. */
export function serializeScopeRows(rows: ScopeRow[]): ApiKeyScope[] {
  return rows
    // A grant the viewer cannot re-grant is dropped — the server would reject
    // the whole request otherwise. The banner says so rather than hiding it.
    .filter((r) => r.kind !== 'locked')
    // A row whose id has not been typed yet is not a scope, so the counter and
    // the chip stay honest the instant the row is added.
    .filter((r) => !(r.kind === 'specific' && r.id.trim().length === 0))
    // Zero ticks IS the "not granted" state.
    .filter((r) => r.permissions.length > 0)
    .map((r) => ({ resource: r.resource, id: r.id.trim(), permissions: [...r.permissions] }));
}

/**
 * Write a preset into the grid.
 *
 * Specific rows are dropped — otherwise the set could never match a preset and
 * the chip would claim something untrue. Locked rows survive: they are facts
 * about the key, not a selection.
 */
export function applyPreset(preset: ApiKeyScopePreset, rows: ScopeRow[]): ScopeRow[] {
  const wanted = new Map<ApiKeyResource, ApiKeyPermission[]>();
  for (const scope of SCOPE_PRESETS[preset]) {
    // Deep-copy: wildcardScopes hands one permissions array to all four entries
    // of a preset, and these are module-level singletons.
    wanted.set(scope.resource, sortPermissions(scope.permissions));
  }
  return rows
    .filter((r) => r.kind !== 'specific')
    .map((r) =>
      r.kind === 'locked' ? { ...r } : { ...r, permissions: [...(wanted.get(r.resource) ?? [])] },
    );
}

/** Add an id-scoped row. Its blank id keeps it out of the wire array until typed. */
export function addSpecificRow(rows: ScopeRow[]): ScopeRow[] {
  const row: ScopeRow = { resource: 'site', id: '', permissions: ['read'], kind: 'specific' };
  const next = [...rows];
  let at = -1;
  for (let i = 0; i < next.length; i++) {
    if (next[i].resource === 'site') at = i;
  }
  if (at !== -1) {
    next.splice(at + 1, 0, row);
    return next;
  }
  const firstLocked = next.findIndex((r) => r.kind === 'locked');
  if (firstLocked !== -1) {
    next.splice(firstLocked, 0, row);
    return next;
  }
  next.push(row);
  return next;
}

export function removeRowAt(rows: ScopeRow[], index: number): ScopeRow[] {
  return rows.filter((_, i) => i !== index);
}

export function updateRowAt(
  rows: ScopeRow[],
  index: number,
  patch: Partial<Pick<ScopeRow, 'resource' | 'id'>>,
): ScopeRow[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
}

export function toggleRowPermission(
  rows: ScopeRow[],
  index: number,
  permission: ApiKeyPermission,
): ScopeRow[] {
  return rows.map((r, i) => {
    if (i !== index) return r;
    const permissions = r.permissions.includes(permission)
      ? r.permissions.filter((p) => p !== permission)
      : sortPermissions([...r.permissions, permission]);
    return { ...r, permissions };
  });
}

/**
 * Re-hydrate when the viewer's role resolves.
 *
 * `isSuperadmin` arrives false-then-true from the user-doc listener, so the
 * platform rows have to be able to appear after mount. Round-tripping through
 * the wire shape preserves every grant; it deliberately does not re-seed from
 * a preset, which would resurrect the same class of silent overwrite.
 */
export function reconcileVisibility(
  rows: ScopeRow[],
  canGrantPlatformScopes: boolean,
): ScopeRow[] {
  return buildScopeRows(serializeScopeRows(rows), canGrantPlatformScopes);
}

/** Pre-flight for the grid. Returns a message, or null when submittable. */
export function validateScopeRows(rows: ScopeRow[]): string | null {
  for (const r of rows) {
    if (r.kind !== 'specific') continue;
    const id = r.id.trim();
    if (id.length === 0) {
      return `${SCOPE_RESOURCE_LABELS[r.resource]}: enter an id, or remove the row`;
    }
    if (id === '*') {
      // The server's validator is shape-only and does not dedupe, so two
      // wildcard rows for one resource would persist and pin the chip to
      // 'custom' forever.
      return `use the "${SCOPE_RESOURCE_LABELS[r.resource]}" row instead of an id of *`;
    }
    if (r.permissions.length === 0) {
      return `${r.resource} ${id}: pick at least one permission`;
    }
  }
  if (serializeScopeRows(rows).length === 0) {
    return 'add at least one scope';
  }
  return null;
}

/** What a pending edit would change, per (resource, id) pair. */
export function summarizeScopeDiff(
  before: ApiKeyScope[] | null,
  after: ApiKeyScope[],
): { added: string[]; removed: string[] } {
  const key = (s: ApiKeyScope) => `${s.resource} ${s.id}`;
  const label = (resource: ApiKeyResource, id: string) =>
    id === '*' ? SCOPE_RESOURCE_LABELS[resource] : `${resource} ${id}`;

  const beforeMap = new Map<string, ApiKeyScope>();
  for (const s of before ?? []) beforeMap.set(key(s), s);
  const afterMap = new Map<string, ApiKeyScope>();
  for (const s of after) afterMap.set(key(s), s);

  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, s] of afterMap) {
    const prior = beforeMap.get(k)?.permissions ?? [];
    const gained = sortPermissions(s.permissions.filter((p) => !prior.includes(p)));
    if (gained.length > 0) {
      added.push(`adds ${gained.join(', ')} on ${label(s.resource, s.id)}`);
    }
  }
  for (const [k, s] of beforeMap) {
    const now = afterMap.get(k)?.permissions ?? [];
    const lost = sortPermissions(s.permissions.filter((p) => !now.includes(p)));
    if (lost.length > 0) {
      removed.push(`removes ${lost.join(', ')} on ${label(s.resource, s.id)}`);
    }
  }
  return { added, removed };
}

/* Shared grid template. Base and specific rows use the same tracks so the
   permission columns line up; below the threshold everything stacks. */
const ROW_GRID =
  'grid grid-cols-1 @min-[32rem]:grid-cols-[minmax(11rem,1fr)_repeat(5,2.75rem)_1.75rem] gap-1.5 items-center rounded border border-border/50 bg-card/40 p-2 @min-[32rem]:border-0 @min-[32rem]:bg-transparent @min-[32rem]:p-0 @min-[32rem]:py-1';

interface Props {
  rows: ScopeRow[];
  onRowsChange: (rows: ScopeRow[]) => void;
  /** From useAuth().isSuperadmin. Gates the platform rows. */
  canGrantPlatformScopes: boolean;
  disabled?: boolean;
}

export function ApiKeyScopeFields({
  rows,
  onRowsChange,
  canGrantPlatformScopes,
  disabled = false,
}: Props) {
  const [showPlatform, setShowPlatform] = useState(() =>
    rows.some((r) => PLATFORM_RESOURCES.includes(r.resource) && r.permissions.length > 0),
  );
  // One level of undo, offered only when a preset click actually discarded
  // id-scoped rows the user had built.
  const [undoRows, setUndoRows] = useState<ScopeRow[] | null>(null);

  const serialized = useMemo(() => serializeScopeRows(rows), [rows]);
  const matched = useMemo(() => presetForScopes(serialized), [serialized]);
  const grantCount = serialized.reduce((n, s) => n + s.permissions.length, 0);

  const lockedRows = rows.filter((r) => r.kind === 'locked');
  const visibleRows = rows.filter(
    (r) => r.kind !== 'locked' && !PLATFORM_RESOURCES.includes(r.resource),
  );
  const platformRows = rows.filter(
    (r) => r.kind === 'base' && PLATFORM_RESOURCES.includes(r.resource),
  );

  function permissionCells(row: ScopeRow, index: number) {
    const subject =
      row.kind === 'specific'
        ? `${row.resource} ${row.id.trim() || 'id'}`
        : SCOPE_RESOURCE_LABELS[row.resource];
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 @min-[32rem]:contents">
        {PERMISSIONS.map((p) => (
          <label
            key={p}
            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer @min-[32rem]:justify-center"
          >
            <Checkbox
              checked={row.permissions.includes(p)}
              onCheckedChange={() => {
                setUndoRows(null);
                onRowsChange(toggleRowPermission(rows, index, p));
              }}
              disabled={disabled}
              className="h-3.5 w-3.5"
              aria-label={`${subject} — ${p}`}
            />
            <span className="@min-[32rem]:sr-only">{p}</span>
          </label>
        ))}
      </div>
    );
  }

  function renderRow(row: ScopeRow, index: number) {
    if (row.kind === 'locked') {
      return (
        <div key={`locked-${row.resource}-${index}`} className={ROW_GRID}>
          <span className="text-xs text-muted-foreground">
            {SCOPE_RESOURCE_LABELS[row.resource]}
          </span>
          {PERMISSIONS.map((p) => (
            <span
              key={p}
              aria-hidden="true"
              className="text-xs text-center text-muted-foreground"
            >
              {row.permissions.includes(p) ? '✓' : '–'}
            </span>
          ))}
          <span className="sr-only">
            {`${SCOPE_RESOURCE_LABELS[row.resource]} — ${row.permissions.join(', ')} — cannot be changed`}
          </span>
          <span aria-hidden="true" />
        </div>
      );
    }

    return (
      <div key={`${row.kind}-${row.resource}-${index}`} className={ROW_GRID}>
        {row.kind === 'base' ? (
          <span className="text-xs text-white">{SCOPE_RESOURCE_LABELS[row.resource]}</span>
        ) : (
          <div className="grid grid-cols-1 @min-[32rem]:grid-cols-[6.5rem_minmax(0,1fr)] gap-1.5">
            <Select
              value={row.resource}
              onValueChange={(v) =>
                onRowsChange(updateRowAt(rows, index, { resource: v as ApiKeyResource }))
              }
              disabled={disabled}
            >
              <SelectTrigger
                aria-label="resource"
                data-testid={`scope-resource-${index}`}
                className="h-7 text-[11px] bg-background border-border text-white"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASE_RESOURCES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="text"
              value={row.id}
              onChange={(e) => onRowsChange(updateRowAt(rows, index, { id: e.target.value }))}
              placeholder="id"
              aria-label="scope id"
              className="h-7 min-w-0 text-[11px] font-mono bg-background border-border text-white"
              disabled={disabled}
            />
          </div>
        )}
        {permissionCells(row, index)}
        {row.kind === 'specific' ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="remove scope row"
            onClick={() => {
              setUndoRows(null);
              onRowsChange(removeRowAt(rows, index));
            }}
            disabled={disabled}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        <Label className="text-white">scope</Label>
        <div className="flex flex-wrap gap-1.5">
          {SCOPE_PRESET_KEYS.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={matched === p ? 'default' : 'outline'}
              aria-pressed={matched === p}
              disabled={disabled}
              onClick={() => {
                setUndoRows(rows.some((r) => r.kind === 'specific') ? rows : null);
                onRowsChange(applyPreset(p, rows));
              }}
              className="h-7 px-2.5 text-xs cursor-pointer"
            >
              {SCOPE_PRESET_LABELS[p]}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2 min-h-[1rem]">
          <p className="text-xs text-muted-foreground">
            {matched !== 'custom'
              ? SCOPE_PRESET_DESCRIPTIONS[matched]
              : 'custom scope set — no preset matches'}
          </p>
          {undoRows && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[11px] cursor-pointer"
              onClick={() => {
                onRowsChange(undoRows);
                setUndoRows(null);
              }}
            >
              undo
            </Button>
          )}
        </div>
      </div>

      <div className="@container space-y-2 rounded-md border border-border bg-card/40 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <Label className="text-white text-sm">what this key can reach</Label>
          <span className="text-xs text-muted-foreground">
            {serialized.length === 0
              ? 'nothing granted yet — tick at least one box'
              : `${serialized.length} scope${serialized.length === 1 ? '' : 's'} · ${grantCount} grant${grantCount === 1 ? '' : 's'}`}
          </span>
        </div>

        <div
          aria-hidden="true"
          className="hidden @min-[32rem]:grid grid-cols-[minmax(11rem,1fr)_repeat(5,2.75rem)_1.75rem] gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          <span />
          {PERMISSIONS.map((p) => (
            <span key={p} className={p === 'admin' ? 'text-center text-amber-400/70' : 'text-center'}>
              {p}
            </span>
          ))}
          <span />
        </div>

        {visibleRows.map((row) => renderRow(row, rows.indexOf(row)))}

        {(canGrantPlatformScopes || lockedRows.length > 0) && (
          <>
            <div className="flex items-center gap-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              superadmin only
              <span className="h-px flex-1 bg-border" />
            </div>
            {canGrantPlatformScopes &&
              (showPlatform ? (
                platformRows.map((row) => renderRow(row, rows.indexOf(row)))
              ) : (
                /* The button names its contents, so `installer` is legible
                   before the click. That is the only reason a disclosure is
                   allowed here at all. */
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowPlatform(true)}
                  disabled={disabled}
                  className="h-auto whitespace-normal text-left px-2 py-1 text-[11px] cursor-pointer"
                >
                  show 2 more: all users, all installer binaries
                </Button>
              ))}
            {lockedRows.length > 0 && (
              <>
                {lockedRows.map((row) => renderRow(row, rows.indexOf(row)))}
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>
                    this key holds scopes only a superadmin can grant. saving removes them.
                  </span>
                </div>
              </>
            )}
          </>
        )}

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setUndoRows(null);
            onRowsChange(addSpecificRow(rows));
          }}
          disabled={disabled}
          className="h-7 px-2 text-xs border-border cursor-pointer"
        >
          <Plus className="h-3 w-3 mr-1" /> limit to a specific id
        </Button>

        <p className="text-[11px] text-muted-foreground">
          presets are shortcuts — what&apos;s ticked here is what gets saved.
        </p>
      </div>
    </>
  );
}
