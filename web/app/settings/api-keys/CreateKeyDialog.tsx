'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  SCOPE_PRESETS,
  type ApiKeyEnvironment,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  type ApiKeyScopePreset,
} from '@/lib/apiKeyTypes';

const RESOURCES: ApiKeyResource[] = ['roost', 'site', 'machine'];
const PERMISSIONS: ApiKeyPermission[] = ['read', 'write', 'deploy', 'rollback', 'admin'];
const PRESETS: ApiKeyScopePreset[] = ['readonly', 'publisher', 'operator', 'admin'];

const PRESET_DESCRIPTIONS: Record<ApiKeyScopePreset, string> = {
  readonly: 'read access to roosts, sites, and machines — no mutations',
  publisher: 'read + write — can upload chunks and publish versions',
  operator: 'read, write, deploy, rollback — full day-to-day operations',
  admin: 'full access including admin permissions',
};

interface CreateKeyResponse {
  success: true;
  key: string;
  keyId: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (rawKey: string) => void;
}

export function CreateKeyDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>('live');
  const [ttlDays, setTtlDays] = useState(DEFAULT_TTL_DAYS);
  const [preset, setPreset] = useState<ApiKeyScopePreset | 'custom'>('publisher');
  const [customScopes, setCustomScopes] = useState<ApiKeyScope[]>([
    { resource: 'site', id: '*', permissions: ['read', 'write'] },
  ]);
  const [creating, setCreating] = useState(false);

  function reset() {
    setName('');
    setEnvironment('live');
    setTtlDays(DEFAULT_TTL_DAYS);
    setPreset('publisher');
    setCustomScopes([{ resource: 'site', id: '*', permissions: ['read', 'write'] }]);
    setCreating(false);
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
    const scopes = preset === 'custom' ? customScopes : SCOPE_PRESETS[preset];
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
      toast.error(`ttlDays must be between 1 and ${MAX_TTL_DAYS}`);
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          ttlDays,
          environment,
        }),
      });
      const data = (await res.json()) as CreateKeyResponse | { detail?: string; error?: string };
      if (res.ok && 'success' in data && data.success) {
        onCreated(data.key);
        reset();
        onOpenChange(false);
        toast.success('api key created');
      } else {
        const msg =
          ('detail' in data && data.detail) ||
          ('error' in data && data.error) ||
          'failed to create key';
        toast.error(msg);
      }
    } catch {
      toast.error('failed to create key');
    }
    setCreating(false);
  }

  function updateCustomScope(index: number, patch: Partial<ApiKeyScope>) {
    setCustomScopes((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function togglePermission(index: number, perm: ApiKeyPermission) {
    setCustomScopes((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const has = s.permissions.includes(perm);
        const permissions = has
          ? s.permissions.filter((p) => p !== perm)
          : [...s.permissions, perm];
        return { ...s, permissions };
      }),
    );
  }

  function addScope() {
    setCustomScopes((prev) => [
      ...prev,
      { resource: 'site', id: '*', permissions: ['read'] },
    ]);
  }

  function removeScope(index: number) {
    setCustomScopes((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-white">create api key</DialogTitle>
          <DialogDescription>
            the raw key is shown once, right after creation. store it somewhere safe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-white">environment</Label>
              <Select
                value={environment}
                onValueChange={(v) => setEnvironment(v as ApiKeyEnvironment)}
                disabled={creating}
              >
                <SelectTrigger className="bg-background border-border text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live">live</SelectItem>
                  <SelectItem value="test">test</SelectItem>
                </SelectContent>
              </Select>
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
                {PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
                <SelectItem value="custom">custom</SelectItem>
              </SelectContent>
            </Select>
            {preset !== 'custom' && (
              <p className="text-xs text-muted-foreground">{PRESET_DESCRIPTIONS[preset]}</p>
            )}
          </div>

          {preset === 'custom' && (
            <div className="space-y-2 rounded-md border border-border bg-background/40 p-3">
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
                  className="grid grid-cols-[110px_1fr_auto] gap-2 items-start rounded border border-border/50 bg-card/40 p-2"
                >
                  <Select
                    value={s.resource}
                    onValueChange={(v) =>
                      updateCustomScope(i, { resource: v as ApiKeyResource })
                    }
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
                      {PERMISSIONS.map((p) => {
                        const checked = s.permissions.includes(p);
                        return (
                          <label
                            key={p}
                            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => togglePermission(i, p)}
                              disabled={creating}
                              className="h-3.5 w-3.5"
                            />
                            {p}
                          </label>
                        );
                      })}
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
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={creating}
            className="border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            type="button"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'create key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
