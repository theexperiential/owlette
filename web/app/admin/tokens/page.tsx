'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KeyRound, Trash2, RefreshCw, AlertTriangle, Clock, CheckCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { AdminButton } from '@/components/admin/AdminButton';

interface TokenInfo {
  id: string;
  machineId: string;
  version: string;
  createdBy: string;
  createdAt: string | null;
  lastUsed: string | null;
  expiresAt: string | null;
  agentUid: string;
}

export default function TokensPage() {
  const { user, isAdmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isAdmin);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeAllDialogOpen, setRevokeAllDialogOpen] = useState(false);
  const [tokenToRevoke, setTokenToRevoke] = useState<TokenInfo | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // Fetch tokens when site changes
  useEffect(() => {
    if (selectedSiteId) {
      fetchTokens();
    } else {
      setTokens([]);
    }
  }, [selectedSiteId]);

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (sites.length > 0 && !selectedSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setSelectedSiteId(savedSite);
      } else {
        setSelectedSiteId(sites[0].id);
      }
    }
  }, [sites, selectedSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setSelectedSiteId(siteId);
    updateLastSite(siteId);
  };

  const fetchTokens = async () => {
    if (!selectedSiteId) return;

    setLoading(true);
    try {
      const response = await fetch(`/api/admin/tokens/list?siteId=${selectedSiteId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch tokens');
      }

      setTokens(data.tokens);
    } catch (error: any) {
      toast.error('Failed to load tokens', {
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeToken = async () => {
    if (!tokenToRevoke) return;

    setIsRevoking(true);
    try {
      const response = await fetch('/api/admin/tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: selectedSiteId,
          tokenId: tokenToRevoke.id,  // Use unique token ID, not machineId
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke token');
      }

      toast.success('Token revoked', {
        description: `Token for ${tokenToRevoke.machineId} has been revoked.`,
      });

      // Refresh token list
      fetchTokens();
    } catch (error: any) {
      toast.error('Failed to revoke token', {
        description: error.message,
      });
    } finally {
      setIsRevoking(false);
      setRevokeDialogOpen(false);
      setTokenToRevoke(null);
    }
  };

  const handleRevokeAll = async () => {
    setIsRevoking(true);
    try {
      const response = await fetch('/api/admin/tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: selectedSiteId,
          all: true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke tokens');
      }

      toast.success('All tokens revoked', {
        description: `${data.revokedCount} token(s) have been revoked.`,
      });

      // Refresh token list
      fetchTokens();
    } catch (error: any) {
      toast.error('Failed to revoke tokens', {
        description: error.message,
      });
    } finally {
      setIsRevoking(false);
      setRevokeAllDialogOpen(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const getExpiryStatus = (expiresAt: string | null) => {
    if (!expiresAt) {
      return { label: 'Never expires', color: 'bg-green-500/20 text-green-400 border-green-500/30' };
    }
    const expiry = new Date(expiresAt);
    const now = new Date();
    if (expiry < now) {
      return { label: 'Expired', color: 'bg-red-500/20 text-red-400 border-red-500/30' };
    }
    const daysUntil = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 7) {
      return { label: `Expires in ${daysUntil}d`, color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' };
    }
    return { label: `Expires ${expiry.toLocaleDateString()}`, color: 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/30' };
  };

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
      {/* Header with inline site selector */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">agent tokens</h1>
            <p className="text-muted-foreground">
              view and revoke agent authentication tokens
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Select value={selectedSiteId} onValueChange={handleSiteChange}>
              <SelectTrigger className="w-[180px] bg-card border-border text-foreground">
                <SelectValue placeholder="select site" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted!">
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={fetchTokens}
                  disabled={!selectedSiteId || loading}
                  className="border-border text-foreground hover:bg-accent! hover:text-foreground!"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>refresh tokens</p>
              </TooltipContent>
            </Tooltip>
            {tokens.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setRevokeAllDialogOpen(true)}
                className="bg-red-600 hover:bg-red-700 cursor-pointer"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                revoke all
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tokens Table */}
      {selectedSiteId && (
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            {loading ? (
              <div className="text-center py-8 text-muted-foreground">loading tokens...</div>
            ) : tokens.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <KeyRound className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>no active tokens for this site</p>
                <p className="text-sm mt-1">Tokens are created when agents register with the site</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-card">
                      <TableHead className="text-foreground">machine ID</TableHead>
                      <TableHead className="text-foreground">version</TableHead>
                      <TableHead className="text-foreground">status</TableHead>
                      <TableHead className="text-foreground">created</TableHead>
                      <TableHead className="text-foreground">last used</TableHead>
                      <TableHead className="text-foreground text-right">actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tokens.map((token) => {
                      const expiryStatus = getExpiryStatus(token.expiresAt);
                      return (
                        <TableRow key={token.id} className="border-border hover:bg-muted/50">
                          <TableCell className="font-mono text-foreground">{token.machineId}</TableCell>
                          <TableCell className="text-foreground">{token.version || 'N/A'}</TableCell>
                          <TableCell>
                            <Badge className={expiryStatus.color}>
                              {expiryStatus.label === 'Never expires' && <CheckCircle className="h-3 w-3 mr-1" />}
                              {expiryStatus.label.includes('Expires') && <Clock className="h-3 w-3 mr-1" />}
                              {expiryStatus.label === 'Expired' && <AlertTriangle className="h-3 w-3 mr-1" />}
                              {expiryStatus.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDate(token.createdAt)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDate(token.lastUsed)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setTokenToRevoke(token);
                                setRevokeDialogOpen(true);
                              }}
                              className="text-amber-400 hover:text-amber-300! hover:bg-amber-950/30!"
                            >
                              <KeyRound className="h-4 w-4 mr-1" />
                              revoke
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Revoke Single Token Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent className="bg-background border-border">
          <DialogHeader>
            <DialogTitle>revoke token for {tokenToRevoke?.machineId}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will immediately invalidate the machine&apos;s authentication token.
              The agent will disconnect and cannot reconnect until re-registered with a new registration code.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <AdminButton
              adminVariant="card"
              onClick={() => setRevokeDialogOpen(false)}
            >
              Cancel
            </AdminButton>
            <Button
              onClick={handleRevokeToken}
              disabled={isRevoking}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isRevoking ? 'revoking...' : 'revoke token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke All Tokens Dialog */}
      <Dialog open={revokeAllDialogOpen} onOpenChange={setRevokeAllDialogOpen}>
        <DialogContent className="bg-background border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="h-5 w-5" />
              revoke all tokens?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will immediately invalidate ALL agent tokens for this site ({tokens.length} tokens).
              All agents will disconnect and require re-registration to reconnect.
              <br /><br />
              <strong className="text-amber-400">this action cannot be undone.</strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <AdminButton
              adminVariant="card"
              onClick={() => setRevokeAllDialogOpen(false)}
            >
              Cancel
            </AdminButton>
            <Button
              onClick={handleRevokeAll}
              disabled={isRevoking}
              className="bg-red-600 hover:bg-red-700"
            >
              {isRevoking ? 'revoking...' : `revoke all ${tokens.length} tokens`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
