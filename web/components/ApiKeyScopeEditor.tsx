'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { UpdateKeyInput } from '@/hooks/useApiKeys';
import {
  ApiKeyScopeFields,
  buildScopeRows,
  reconcileVisibility,
  type ScopeRow,
  serializeScopeRows,
  summarizeScopeDiff,
  validateScopeRows,
} from '@/components/ApiKeyScopeFields';
import type { ApiKeyListItem } from '@/lib/apiKeyTypes';

/**
 * Edit an existing key's name and scopes in place.
 *
 * The alternative — revoke and recreate — means every consumer of that
 * credential has to be updated to widen a permission, which is why a key
 * issued a scope short of what it needed tended to get replaced by an
 * over-broad one instead. Rotation does not help: it also hands out a new
 * secret. The secret is untouched here; only what it can reach changes.
 *
 * ttl and environment are deliberately absent: the server rejects both on
 * PATCH (rotate is the way to extend expiry), so offering the fields would
 * only produce a 400.
 */

interface Props {
  apiKey: ApiKeyListItem;
  onSubmit: (input: UpdateKeyInput) => Promise<void>;
  onCancel: () => void;
  /** From useAuth().isSuperadmin — gates the platform-wide scope rows. */
  canGrantPlatformScopes: boolean;
}

export function ApiKeyScopeEditor({
  apiKey,
  onSubmit,
  onCancel,
  canGrantPlatformScopes,
}: Props) {
  const [name, setName] = useState(apiKey.name || '');
  const [rows, setRows] = useState<ScopeRow[]>(() =>
    buildScopeRows(apiKey.scopes, canGrantPlatformScopes),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows((prev) => reconcileVisibility(prev, canGrantPlatformScopes));
  }, [canGrantPlatformScopes]);

  // Editor-only: on create every grant is new, so a diff would just restate the
  // table. Here the operator is mutating a credential whose consumers are
  // already running, and PATCH's audit event exists precisely to make a widening
  // visible — showing it before the write beats only recording it after.
  const pending = useMemo(
    () => summarizeScopeDiff(apiKey.scopes, serializeScopeRows(rows)),
    [apiKey.scopes, rows],
  );
  // A key predating scoped auth stores no scopes at all and authenticates as
  // full access. Editing it is a narrowing, not an adjustment.
  const isLegacy = !apiKey.scopes || apiKey.scopes.length === 0;

  async function handleSave() {
    const validationError = validateScopeRows(rows);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    if (!name.trim()) {
      toast.error('name is required');
      return;
    }

    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        scopes: serializeScopeRows(rows),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    /* Square top, no top border: this is the lower half of the row above it,
       not a second card. With several keys listed, a detached panel gives no
       indication of which one it is editing. */
    <div className="space-y-4 rounded-md rounded-t-none border border-t-0 border-accent-cyan/50 bg-background/40 p-3">
      <h3 className="text-sm font-medium text-white">
        editing <span className="text-accent-cyan">{apiKey.name || '(unnamed key)'}</span>
      </h3>
      <p className="text-xs text-muted-foreground">
        the key itself does not change — anything already using{' '}
        <code className="font-mono">{apiKey.keyPrefix || 'owk_'}•••</code> keeps working with the
        new scopes on its next request.
      </p>

      {isLegacy && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            this is a legacy key with no scope list, which authenticates as full access. saving
            replaces that with exactly what you pick below — anything relying on it needs to be
            covered by these scopes.
          </span>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="editKeyName" className="text-white">
          name
        </Label>
        <Input
          id="editKeyName"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-background border-border text-white"
          disabled={saving}
        />
      </div>

      <ApiKeyScopeFields
        rows={rows}
        onRowsChange={setRows}
        canGrantPlatformScopes={canGrantPlatformScopes}
        disabled={saving}
      />

      {(pending.added.length > 0 || pending.removed.length > 0) && (
        <div className="space-y-1 rounded-md border border-border bg-card/40 p-2">
          <span className="text-xs text-white">pending changes</span>
          <ul className="space-y-0.5">
            {pending.added.map((line) => (
              <li key={line} className="text-xs text-accent-cyan">
                + {line}
              </li>
            ))}
            {pending.removed.map((line) => (
              <li key={line} className="text-xs text-amber-400">
                − {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="text-gray-900 cursor-pointer"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'save changes'}
        </Button>
      </div>
    </div>
  );
}
