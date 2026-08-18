'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { CopyButton } from '@/components/CopyButton';
import { Key, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useApiKeys, type CreateKeyInput, type UpdateKeyInput } from '@/hooks/useApiKeys';
import { ApiKeyCreateForm } from '@/components/ApiKeyCreateForm';
import { ApiKeyScopeEditor } from '@/components/ApiKeyScopeEditor';
import { KeyCard } from '@/app/settings/api-keys/KeyCard';

/**
 * One panel for api keys, mounted in both places keys are managed.
 *
 * The account-settings dialog and /settings/api-keys were not two views of one
 * feature — they were one feature and a degraded copy of it. The dialog could
 * create with a preset and revoke; it could not set a ttl, build custom
 * scopes, rotate, or show what a key was scoped to. Since the dialog is the
 * discoverable surface and the page is the one people could not find, the
 * capable half lived where nobody looked.
 *
 * `compact` trims the chrome for the dialog (no page heading, tighter
 * spacing); everything functional is identical in both.
 *
 * KeyCard is rendered rather than reimplemented — six e2e specs bind to its
 * DOM shape (`div.rounded-md.border`, `p.font-medium`, `[data-slot="badge"]`,
 * `svg.lucide-refresh-cw`, `svg.lucide-trash-2`, a `code` holding the prefix).
 * Restyling it is a separate change from moving it.
 */

interface Props {
  /** Trim page-level chrome for embedding in the settings dialog. */
  compact?: boolean;
}

export function ApiKeysManager({ compact = false }: Props) {
  const { keys, loading, refresh, createKey, updateKey } = useApiKeys();
  const [creating, setCreating] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  // One clock for the whole list so two rows can't disagree about "expiring soon".
  const [now] = useState(() => Date.now());

  // Pre-expand when there is nothing to look at — an empty list with a
  // collapsed form is a dead end.
  const showForm = creating;

  async function handleCreate(input: CreateKeyInput) {
    try {
      const created = await createKey(input);
      setRevealedKey(created.key);
      setCreating(false);
      toast.success('api key created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to create key');
    }
  }

  async function handleUpdate(keyId: string, input: UpdateKeyInput) {
    try {
      await updateKey(keyId, input);
      setEditingKeyId(null);
      toast.success('key updated — new scopes apply immediately');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to update key');
    }
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      {!compact && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
              <Key className="h-5 w-5" />
              api keys
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              scoped tokens for automating pushes, rollbacks, and deploys against the roost api.
            </p>
          </div>
        </div>
      )}

      {/* Fed by create AND rotate — both return a raw value shown exactly once.
          Markup deliberately matches what the specs bind to: the banner copy,
          a [data-slot="card"] ancestor, and the code/CopyButton flex pair. */}
      {revealedKey && (
        <Card className="border-accent-cyan/50 bg-accent-cyan/5 p-4 relative">
          <button
            type="button"
            onClick={() => setRevealedKey(null)}
            className="absolute top-3 right-3 text-muted-foreground hover:text-white"
            aria-label="dismiss"
          >
            <X className="h-4 w-4" />
          </button>
          <p className="text-sm text-accent-cyan font-medium pr-6 mb-2">
            key issued — copy it now. it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background border border-border rounded px-3 py-2 text-white font-mono break-all select-all">
              {revealedKey}
            </code>
            <CopyButton
              value={revealedKey}
              className="h-9 border-border text-accent-cyan hover:bg-muted"
            />
          </div>
        </Card>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-white">your keys</Label>
          {!showForm && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setEditingKeyId(null);
                setCreating(true);
              }}
              className="cursor-pointer text-gray-900"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> create key
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> loading keys…
          </div>
        ) : keys.length === 0 ? (
          <Card className="border-border bg-card/50 p-8 text-center space-y-3">
            <KeyRound className="h-8 w-8 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm text-white">no api keys yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                create a scoped key to start automating against the roost api.
              </p>
            </div>
            {!showForm && (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditingKeyId(null);
                  setCreating(true);
                }}
                className="text-gray-900 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> create your first key
              </Button>
            )}
          </Card>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.id} className="space-y-2">
                <KeyCard
                  apiKey={k}
                  now={now}
                  // KeyCard owns the rotate/revoke requests and hands back the
                  // raw value; the panel only reveals it and resyncs the list.
                  onRotated={(raw) => {
                    setRevealedKey(raw);
                    refresh().catch(() => {});
                  }}
                  onRevoked={() => {
                    if (editingKeyId === k.id) setEditingKeyId(null);
                    refresh().catch(() => {});
                  }}
                  onEditScopes={(target) => {
                    // Only one form open at a time — the create form and an
                    // editor side by side both claim to be "the" scope picker.
                    setCreating(false);
                    setEditingKeyId((current) => (current === target.id ? null : target.id));
                  }}
                />
                {editingKeyId === k.id && (
                  <ApiKeyScopeEditor
                    apiKey={k}
                    onSubmit={(input) => handleUpdate(k.id, input)}
                    onCancel={() => setEditingKeyId(null)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <div className="space-y-2">
          <Label className="text-white">create key</Label>
          <ApiKeyCreateForm onSubmit={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}
    </div>
  );
}
