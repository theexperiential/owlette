'use client';

import { useState } from 'react';
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
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { CreateKeyInput } from '@/hooks/useApiKeys';
import {
  ALL_RESOURCES,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  type ApiKeyScopePreset,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  SCOPE_PRESET_DESCRIPTIONS,
  SCOPE_PRESET_KEYS,
  SCOPE_PRESET_LABELS,
  SCOPE_PRESETS,
} from '@/lib/apiKeyTypes';

/**
 * The create-key form, inline rather than in its own modal.
 *
 * It used to live only inside CreateKeyDialog on /settings/api-keys, which is
 * why the account dialog's create could not offer a ttl or custom scopes —
 * that surface had a reduced reimplementation instead of this. Rendering
 * inline lets one panel host it: nesting a modal inside the account settings
 * dialog would stack two focus traps.
 */

const RESOURCES: readonly ApiKeyResource[] = ALL_RESOURCES;
const PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];

interface Props {
  onSubmit: (input: CreateKeyInput) => Promise<void>;
  onCancel: () => void;
}

export function ApiKeyCreateForm({ onSubmit, onCancel }: Props) {
  const [name, setName] = useState('');
  const [ttlDays, setTtlDays] = useState(DEFAULT_TTL_DAYS);
  const [preset, setPreset] = useState<ApiKeyScopePreset | 'custom'>('publisher');
  const [customScopes, setCustomScopes] = useState<ApiKeyScope[]>([
    { resource: 'site', id: '*', permissions: ['read', 'write'] },
  ]);
  const [creating, setCreating] = useState(false);

  function updateCustomScope(index: number, patch: Partial<ApiKeyScope>) {
    setCustomScopes((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function togglePermission(index: number, permission: ApiKeyPermission) {
    setCustomScopes((prev) =>
      prev.map((s, i) =>
        i === index
          ? {
              ...s,
              permissions: s.permissions.includes(permission)
                ? s.permissions.filter((p) => p !== permission)
                : [...s.permissions, permission],
            }
          : s,
      ),
    );
  }

  function addScope() {
    setCustomScopes((prev) => [...prev, { resource: 'site', id: '*', permissions: ['read'] }]);
  }

  function removeScope(index: number) {
    setCustomScopes((prev) => prev.filter((_, i) => i !== index));
  }

  function validateCustomScopes(): string | null {
    if (preset !== 'custom') return null;
    if (customScopes.length === 0) return 'add at least one scope';
    for (let i = 0; i < customScopes.length; i++) {
      const s = customScopes[i];
      if (!s.id || s.id.trim().length === 0) return `scope ${i + 1}: id is required (use * for all)`;
      if (s.permissions.length === 0) return `scope ${i + 1}: pick at least one permission`;
    }
    return null;
  }

  async function handleCreate() {
    const validationError = validateCustomScopes();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    if (!name.trim()) {
      toast.error('name is required');
      return;
    }
    if (ttlDays < 1 || ttlDays > MAX_TTL_DAYS) {
      toast.error(`ttl must be between 1 and ${MAX_TTL_DAYS} days`);
      return;
    }

    setCreating(true);
    try {
      await onSubmit({
        name: name.trim(),
        scopes: preset === 'custom' ? customScopes : SCOPE_PRESETS[preset],
        ttlDays,
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-background/40 p-3">
      {/* Heading kept from the modal this replaced — the e2e specs anchor on
          it, and it still labels the region now that it is inline. */}
      <h3 className="text-sm font-medium text-white">create api key</h3>
      <p className="text-xs text-muted-foreground">
        the raw key is shown once, right after creation. store it somewhere safe.
      </p>
      <div className="space-y-2">
        <Label htmlFor="keyName" className="text-white">
          name
        </Label>
        <Input
          id="keyName"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ci/cd — publisher"
          className="bg-background border-border text-white"
          disabled={creating}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="ttlDays" className="text-white">
          ttl (days)
        </Label>
        <Input
          id="ttlDays"
          type="number"
          min={1}
          max={MAX_TTL_DAYS}
          value={ttlDays}
          onChange={(e) => setTtlDays(Number(e.target.value) || DEFAULT_TTL_DAYS)}
          className="bg-background border-border text-white"
          disabled={creating}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-white">scope</Label>
        <Select
          value={preset}
          onValueChange={(v) => setPreset(v as typeof preset)}
          disabled={creating}
        >
          <SelectTrigger className="bg-background border-border text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPE_PRESET_KEYS.map((p) => (
              <SelectItem key={p} value={p}>
                {SCOPE_PRESET_LABELS[p]}
              </SelectItem>
            ))}
            <SelectItem value="custom">custom</SelectItem>
          </SelectContent>
        </Select>
        {preset !== 'custom' && (
          <p className="text-xs text-muted-foreground">{SCOPE_PRESET_DESCRIPTIONS[preset]}</p>
        )}
      </div>

      {preset === 'custom' && (
        <div className="space-y-2 rounded-md border border-border bg-card/40 p-3">
          <div className="flex items-center justify-between">
            <Label className="text-white text-sm">custom scopes</Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addScope}
              disabled={creating}
              className="h-7 px-2 text-xs border-border cursor-pointer"
            >
              <Plus className="h-3 w-3 mr-1" /> add
            </Button>
          </div>
          {customScopes.map((s, i) => (
            <div
              key={i}
              /* Stacks below sm: at 390px a fixed 110px select beside the id
                 input leaves ~180px, which is not enough for a scope id. */
              className="grid grid-cols-1 sm:grid-cols-[110px_1fr_auto] gap-2 items-start rounded border border-border/50 bg-card/40 p-2"
            >
              <Select
                value={s.resource}
                onValueChange={(v) => updateCustomScope(i, { resource: v as ApiKeyResource })}
                disabled={creating}
              >
                <SelectTrigger className="h-8 text-xs bg-background border-border text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOURCES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-2">
                <Input
                  type="text"
                  value={s.id}
                  onChange={(e) => updateCustomScope(i, { id: e.target.value })}
                  placeholder="id (or * for all)"
                  className="h-8 text-xs bg-background border-border text-white"
                  disabled={creating}
                />
                <div className="flex flex-wrap gap-2">
                  {PERMISSIONS.map((p) => (
                    <label
                      key={p}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                    >
                      <Checkbox
                        checked={s.permissions.includes(p)}
                        onCheckedChange={() => togglePermission(i, p)}
                        disabled={creating}
                        className="h-3.5 w-3.5"
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => removeScope(i)}
                disabled={creating || customScopes.length <= 1}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={creating}
          className="border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="button"
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="text-gray-900 cursor-pointer"
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'create key'}
        </Button>
      </div>
    </div>
  );
}
