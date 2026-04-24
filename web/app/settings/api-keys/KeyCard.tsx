'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Loader2, RefreshCw, Trash2, AlertTriangle, Clock, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';

export interface ApiKeyListItem {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  environment: 'live' | 'test' | null;
  scopes: ApiKeyScope[] | null;
  expiresAt: number | null;
  createdAt: number | null;
  lastUsedAt: number | null;
  rotatedAt: number | null;
  rotatedFromKeyId: string | null;
  retiresAt: number | null;
  revokedAt: number | null;
  expiredMarkedAt: unknown;
  expired: boolean;
  retired: boolean;
}

const EXPIRATION_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function summarizeScopes(scopes: ApiKeyScope[] | null): string {
  if (!scopes || scopes.length === 0) return 'legacy (full access)';
  const permSet = new Set<string>();
  for (const s of scopes) for (const p of s.permissions) permSet.add(p);
  const perms = Array.from(permSet).sort().join(', ');
  const resources = Array.from(new Set(scopes.map((s) => s.resource))).sort().join('/');
  return `${resources} · ${perms}`;
}

function keyStatusAt(
  k: ApiKeyListItem,
  now: number,
): {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
} {
  if (k.expired) return { label: 'expired', tone: 'error' };
  if (k.retired) return { label: 'retired', tone: 'muted' };
  if (k.rotatedAt && k.retiresAt && k.retiresAt > now) {
    return { label: 'rotated (grace)', tone: 'warn' };
  }
  if (
    typeof k.expiresAt === 'number' &&
    k.expiresAt - now < EXPIRATION_WARNING_MS
  ) {
    return { label: 'expiring soon', tone: 'warn' };
  }
  return { label: 'active', tone: 'ok' };
}

function formatRelativeAt(ms: number | null, now: number): string {
  if (!ms) return 'never';
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ms);
}

interface Props {
  apiKey: ApiKeyListItem;
  onRotated: (raw: string, newKeyId: string) => void;
  onRevoked: () => void;
  /** Snapshot of Date.now() passed down from the parent on each tick. Injected so the render stays pure (lint rule). */
  now: number;
}

export function KeyCard({ apiKey, onRotated, onRevoked, now }: Props) {
  const [rotating, setRotating] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const status = keyStatusAt(apiKey, now);
  const daysUntilExpiry =
    typeof apiKey.expiresAt === 'number'
      ? Math.max(1, Math.ceil((apiKey.expiresAt - now) / (24 * 60 * 60 * 1000)))
      : null;

  async function handleRotate() {
    setRotating(true);
    try {
      const res = await fetch(`/api/keys/${apiKey.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success('key rotated — old key works for 24h');
        onRotated(data.key, data.keyId);
      } else {
        toast.error(data.detail || data.error || 'rotation failed');
      }
    } catch {
      toast.error('rotation failed');
    }
    setRotating(false);
  }

  async function handleRevoke() {
    setRevoking(true);
    try {
      const res = await fetch(`/api/keys/${apiKey.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('key revoked');
        onRevoked();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.detail || data.error || 'revoke failed');
      }
    } catch {
      toast.error('revoke failed');
    }
    setRevoking(false);
    setConfirmRevoke(false);
  }

  return (
    <div className="rounded-md border border-border bg-card/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-white font-medium truncate">
              {apiKey.name || '(unnamed key)'}
            </p>
            {apiKey.environment && (
              <Badge
                variant="outline"
                className={
                  apiKey.environment === 'live'
                    ? 'border-accent-cyan/50 text-accent-cyan text-xs'
                    : 'border-amber-500/50 text-amber-400 text-xs'
                }
              >
                {apiKey.environment}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={
                status.tone === 'ok'
                  ? 'border-green-500/50 text-green-400 text-xs'
                  : status.tone === 'warn'
                    ? 'border-amber-500/50 text-amber-400 text-xs'
                    : status.tone === 'error'
                      ? 'border-red-500/50 text-red-400 text-xs'
                      : 'border-border text-muted-foreground text-xs'
              }
            >
              {status.label}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <code className="font-mono">{apiKey.keyPrefix || 'owk_'}•••</code>
            <span className="flex items-center gap-1">
              <KeyRound className="h-3 w-3" />
              {summarizeScopes(apiKey.scopes)}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span>created {formatDate(apiKey.createdAt)}</span>
            <span>last used {formatRelativeAt(apiKey.lastUsedAt, now)}</span>
            {apiKey.expiresAt && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                expires {formatDate(apiKey.expiresAt)}
              </span>
            )}
          </div>
          {status.tone === 'warn' && status.label === 'expiring soon' && daysUntilExpiry !== null && (
            <div className="flex items-center gap-2 text-xs text-amber-400 pt-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              this key expires in {daysUntilExpiry} day(s). rotate it soon.
            </div>
          )}
          {status.label === 'rotated (grace)' && apiKey.retiresAt && (
            <div className="flex items-center gap-2 text-xs text-amber-400 pt-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              old key stops working {formatDate(apiKey.retiresAt)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!apiKey.expired && !apiKey.retired && !apiKey.rotatedAt && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleRotate}
                  disabled={rotating}
                  className="h-8 px-2 border-border text-muted-foreground hover:text-white cursor-pointer"
                >
                  {rotating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>rotate — issues new key, old works 24h</p>
              </TooltipContent>
            </Tooltip>
          )}
          {!confirmRevoke ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmRevoke(true)}
                  className="h-8 px-2 border-border text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>revoke this key immediately</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-red-400">revoke?</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleRevoke}
                disabled={revoking}
                className="h-7 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
              >
                {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'yes'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRevoke(false)}
                disabled={revoking}
                className="h-7 px-2 text-xs text-muted-foreground cursor-pointer"
              >
                no
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
