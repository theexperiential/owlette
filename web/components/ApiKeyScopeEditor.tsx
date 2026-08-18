'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { UpdateKeyInput } from '@/hooks/useApiKeys';
import {
  ApiKeyScopeFields,
  presetForScopes,
  resolveScopes,
  type ScopeSelection,
  validateScopeSelection,
} from '@/components/ApiKeyScopeFields';
import type { ApiKeyListItem, ApiKeyScope } from '@/lib/apiKeyTypes';

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
}

export function ApiKeyScopeEditor({ apiKey, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(apiKey.name || '');
  // A key minted from a preset reopens on that preset; anything else (or a
  // legacy key with no scopes at all) starts in the custom builder.
  const [preset, setPreset] = useState<ScopeSelection>(() => presetForScopes(apiKey.scopes));
  const [customScopes, setCustomScopes] = useState<ApiKeyScope[]>(() =>
    apiKey.scopes && apiKey.scopes.length > 0
      ? apiKey.scopes.map((s) => ({ ...s, permissions: [...s.permissions] }))
      : [{ resource: 'site', id: '*', permissions: ['read'] }],
  );
  const [saving, setSaving] = useState(false);
  // A key predating scoped auth stores no scopes at all and authenticates as
  // full access. Editing it is a narrowing, not an adjustment.
  const isLegacy = !apiKey.scopes || apiKey.scopes.length === 0;

  async function handleSave() {
    const validationError = validateScopeSelection(preset, customScopes);
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
        scopes: resolveScopes(preset, customScopes),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-background/40 p-3">
      <h3 className="text-sm font-medium text-white">edit api key</h3>
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
        preset={preset}
        onPresetChange={setPreset}
        customScopes={customScopes}
        onCustomScopesChange={setCustomScopes}
        disabled={saving}
      />

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
