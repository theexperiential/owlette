'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, KeyRound, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  SCOPE_PRESETS,
  type ApiKeyEnvironment,
  type ApiKeyScopePreset,
} from '@/lib/apiKeyTypes';

const PRESETS: ApiKeyScopePreset[] = ['readonly', 'publisher', 'operator', 'admin'];

function CliAuthorizeInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const code = (searchParams?.get('code') ?? '').toLowerCase().trim();
  const [name, setName] = useState('my cli');
  const [preset, setPreset] = useState<ApiKeyScopePreset>('publisher');
  const [ttlDays, setTtlDays] = useState(DEFAULT_TTL_DAYS);
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>('live');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const next = encodeURIComponent(`/cli/authorize?code=${code}`);
      router.push(`/login?redirect=${next}`);
    }
  }, [user, authLoading, router, code]);

  async function handleAuthorize() {
    if (!code) {
      toast.error('pairing phrase missing — re-run `roost auth login` in the cli');
      return;
    }
    if (!name.trim()) {
      toast.error('name is required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/cli/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          name: name.trim(),
          scopes: SCOPE_PRESETS[preset],
          ttlDays,
          environment,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setDone(true);
        toast.success('cli authorised — return to your terminal');
      } else {
        toast.error(data.detail || data.error || 'authorisation failed');
      }
    } catch {
      toast.error('authorisation failed');
    }
    setSubmitting(false);
  }

  if (authLoading || !user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader currentPage="api keys" />
      <main className="max-w-xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> authorise cli
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            issue a scoped api key to the cli that requested this pairing phrase.
          </p>
        </div>

        {done ? (
          <Card className="border-green-500/50 bg-green-500/5 p-6 text-center space-y-3">
            <CheckCircle2 className="h-8 w-8 text-green-400 mx-auto" />
            <p className="text-sm text-white">cli authorised</p>
            <p className="text-xs text-muted-foreground">
              return to your terminal — the cli is polling and will pick up the key
              within a few seconds.
            </p>
          </Card>
        ) : (
          <Card className="border-border bg-card/50 p-6 space-y-4">
            <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>
                pairing phrase:{' '}
                <code className="font-mono">{code || '(missing)'}</code> — verify this
                matches what your cli printed.
              </span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cliKeyName" className="text-white">
                key name
              </Label>
              <Input
                id="cliKeyName"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. laptop-dev, ci-runner"
                className="bg-background border-border text-white"
                disabled={submitting}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-white">environment</Label>
                <Select
                  value={environment}
                  onValueChange={(v) => setEnvironment(v as ApiKeyEnvironment)}
                  disabled={submitting}
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
                <Label htmlFor="cliTtlDays" className="text-white">
                  ttl (days)
                </Label>
                <Input
                  id="cliTtlDays"
                  type="number"
                  min={1}
                  max={MAX_TTL_DAYS}
                  value={ttlDays}
                  onChange={(e) => setTtlDays(Number(e.target.value) || DEFAULT_TTL_DAYS)}
                  className="bg-background border-border text-white"
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-white">scope preset</Label>
              <Select
                value={preset}
                onValueChange={(v) => setPreset(v as ApiKeyScopePreset)}
                disabled={submitting}
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
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                use the settings → api keys page for fine-grained scope customisation.
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                onClick={handleAuthorize}
                disabled={submitting || !code || !name.trim()}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'authorise'
                )}
              </Button>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}

export default function CliAuthorizePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <CliAuthorizeInner />
    </Suspense>
  );
}
