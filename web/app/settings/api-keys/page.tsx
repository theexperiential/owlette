'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useAccountTier } from '@/hooks/useAccountTier';
import { PageHeader } from '@/components/PageHeader';
import { ProTierGate } from '@/components/billing/ProTierGate';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loader2, Plus, KeyRound, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { CopyButton } from '@/components/CopyButton';
import { CreateKeyDialog } from './CreateKeyDialog';
import { KeyCard, type ApiKeyListItem } from './KeyCard';

interface KeysResponse {
  success: true;
  keys: ApiKeyListItem[];
}

export default function ApiKeysSettingsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [keys, setKeys] = useState<ApiKeyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Account-scoped, not site-scoped: an api key spans every site the account
  // owns, which is exactly the rule `requireProAccount()` applies server-side
  // on `POST /api/account/api-keys`.
  const accountTier = useAccountTier();
  // The full-card gate replaces the page only when there is nothing behind it
  // to audit or revoke. With keys on file the page keeps rendering and the
  // inline gate takes the create button's place instead — listing and revoking
  // are ungated server-side, so hiding them would take away controls the api
  // would still honour. `!loading` is load-bearing: an empty `keys` array
  // before the first response is "unknown", not "none".
  const showEmptyStateGate = accountTier === 'core' && !loading && keys.length === 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/keys');
      const data = (await res.json()) as KeysResponse | { detail?: string; error?: string };
      if (res.ok && 'success' in data && data.success) {
        setKeys(data.keys);
        setNow(Date.now());
      } else {
        const msg =
          ('detail' in data && data.detail) ||
          ('error' in data && data.error) ||
          'failed to load keys';
        toast.error(msg);
      }
    } catch {
      toast.error('failed to load keys');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount; the state update lives inside refresh()
    refresh().catch(() => {});
  }, [user, authLoading, router, refresh]);

  function handleCreated(rawKey: string) {
    setRevealedKey(rawKey);
    void refresh();
  }

  function handleRotated(rawKey: string) {
    setRevealedKey(rawKey);
    void refresh();
  }

  if (authLoading || (!user && loading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader currentPage="api keys" />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {showEmptyStateGate ? (
          <ProTierGate
            tier={accountTier}
            feature="api access"
            blurb="api keys are included in the pro tier — they authenticate the public REST API, the CLI, and the SDK. upgrade your account to enable."
          />
        ) : (
          <>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
                  <KeyRound className="h-5 w-5" />
                  api keys
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  scoped tokens for automating pushes, rollbacks, and deploys against the roost api.
                </p>
              </div>
              {/* Creation is the only pro-gated operation on this surface —
                  `POST /api/account/api-keys` carries `requireProAccount()`.
                  Rotate and revoke below stay live for a downgraded account
                  because the server never gated them, and revocation must not
                  depend on a subscription. */}
              <ProTierGate tier={accountTier} variant="inline" item="api keys">
                <Button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="text-gray-900 cursor-pointer"
                >
                  <Plus className="h-4 w-4 mr-1" /> create key
                </Button>
              </ProTierGate>
            </div>

            {revealedKey && (
              <Card className="border-accent-cyan/50 bg-accent-cyan/5 p-4 mb-6 relative">
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

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                  className="text-gray-900 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> create your first key
                </Button>
              </Card>
            ) : (
              <div className="space-y-3">
                {keys.map((k) => (
                  <KeyCard
                    key={k.id}
                    apiKey={k}
                    onRotated={handleRotated}
                    onRevoked={refresh}
                    now={now}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Only reachable from a button inside the gate, so a core account can
          never open it — kept mounted here (rather than gated) so an
          in-flight create survives a tier snapshot arriving late. */}
      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </div>
  );
}
