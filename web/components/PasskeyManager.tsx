'use client';

import { useState } from 'react';
import { Fingerprint, Pencil, Trash2, Plus, Check, X, Smartphone, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePasskeys } from '@/hooks/usePasskeys';
import { toast } from 'sonner';

interface PasskeyManagerProps {
  userId: string;
  compact?: boolean;
}

export function PasskeyManager({ userId, compact = false }: PasskeyManagerProps) {
  const {
    passkeys,
    loading,
    supported,
    registerPasskey,
    deletePasskey,
    renamePasskey,
  } = usePasskeys(userId);

  const [registering, setRegistering] = useState(false);
  const [newPasskeyName, setNewPasskeyName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!supported) {
    return null;
  }

  const handleRegister = async () => {
    if (!showNameInput) {
      setShowNameInput(true);
      setNewPasskeyName('');
      return;
    }

    setRegistering(true);
    try {
      await registerPasskey(newPasskeyName || 'Passkey');
      toast.success('passkey registered successfully');
      setShowNameInput(false);
      setNewPasskeyName('');
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        toast.error('passkey registration was cancelled');
      } else {
        toast.error(err instanceof Error ? err.message : 'failed to register passkey');
      }
    } finally {
      setRegistering(false);
    }
  };

  const handleRename = async (credentialId: string) => {
    if (!editName.trim()) return;
    try {
      await renamePasskey(credentialId, editName.trim());
      setEditingId(null);
      toast.success('passkey renamed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to rename passkey');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePasskey(deleteTarget.id);
      toast.success('passkey removed');
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to delete passkey');
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getDeviceIcon = (deviceType: string) => {
    if (deviceType === 'multiDevice') return <Smartphone className="h-4 w-4 text-muted-foreground" />;
    return <Monitor className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <>
      <Card className={`bg-card/50 border-border ${compact ? '' : 'mt-4'}`}>
        <CardHeader className={compact ? 'pb-2' : ''}>
          <CardTitle className="text-foreground flex items-center gap-2 text-lg">
            <Fingerprint className="h-5 w-5 text-accent-cyan" />
            passkeys
          </CardTitle>
          {!compact && (
            <CardDescription className="text-muted-foreground">
              sign in faster with biometrics or your device PIN. passkeys replace both your password and 2FA.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">loading...</p>
          ) : (
            <>
              {passkeys.length === 0 && !showNameInput && (
                <p className="text-sm text-muted-foreground">no passkeys registered yet.</p>
              )}

              {passkeys.map((pk) => (
                <div
                  key={pk.credentialId}
                  className="flex items-center justify-between rounded-md border border-border bg-input/50 px-3 py-2"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {getDeviceIcon(pk.deviceType)}
                    <div className="min-w-0">
                      {editingId === pk.credentialId ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="h-7 w-40 text-sm bg-input border-border text-foreground"
                            maxLength={50}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename(pk.credentialId);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 cursor-pointer"
                            onClick={() => handleRename(pk.credentialId)}
                          >
                            <Check className="h-3.5 w-3.5 text-green-400" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 cursor-pointer"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-medium text-foreground truncate">
                            {pk.friendlyName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            added {formatDate(pk.createdAt)}
                            {pk.backedUp && ' \u00b7 synced'}
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  {editingId !== pk.credentialId && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 cursor-pointer"
                        onClick={() => {
                          setEditingId(pk.credentialId);
                          setEditName(pk.friendlyName);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 cursor-pointer"
                        onClick={() => setDeleteTarget({ id: pk.credentialId, name: pk.friendlyName })}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-400" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}

              {showNameInput && (
                <div className="flex items-center gap-2">
                  <Input
                    value={newPasskeyName}
                    onChange={(e) => setNewPasskeyName(e.target.value)}
                    placeholder="passkey name (e.g. MacBook, iPhone)"
                    className="h-9 text-sm bg-input border-border text-foreground placeholder:text-muted-foreground"
                    maxLength={50}
                    autoFocus
                    disabled={registering}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRegister();
                      if (e.key === 'Escape') setShowNameInput(false);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 cursor-pointer"
                    onClick={() => setShowNameInput(false)}
                    disabled={registering}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                className="w-full bg-input border-border text-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                onClick={handleRegister}
                disabled={registering}
              >
                {registering ? (
                  'waiting for device...'
                ) : showNameInput ? (
                  <>
                    <Fingerprint className="mr-2 h-4 w-4" />
                    register passkey
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    add passkey
                  </>
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="border-border bg-secondary text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">remove passkey</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to remove <span className="font-mono text-white">{deleteTarget?.name}</span>?
              you won&apos;t be able to sign in with this passkey anymore.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              className="bg-input border-border text-foreground hover:bg-muted cursor-pointer"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              className="cursor-pointer"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'removing...' : 'remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
