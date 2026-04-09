'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  query,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Webhook,
  Plus,
  Trash2,
  Send,
  Eye,
  EyeOff,
  Copy,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Pencil,
} from 'lucide-react';
import { toast } from 'sonner';

interface WebhookData {
  id: string;
  url: string;
  name: string;
  events: string[];
  enabled: boolean;
  secret: string;
  createdAt: Date | null;
  createdBy: string;
  lastTriggered: Date | null;
  lastStatus: number;
  failCount: number;
}

const SUPPORTED_EVENTS = [
  { id: 'machine.offline', label: 'machine offline', description: 'machine stops sending heartbeats' },
  { id: 'process.crashed', label: 'process crashed', description: 'a monitored process crashes' },
  { id: 'process.restarted', label: 'process restarted', description: 'a monitored process is restarted' },
  { id: 'machine.online', label: 'machine online', description: 'machine comes back online (future)' },
  { id: 'deployment.completed', label: 'deployment completed', description: 'software deployment succeeds (future)' },
  { id: 'deployment.failed', label: 'deployment failed', description: 'software deployment fails (future)' },
];

/* -------------------------------------------------------------------------- */
/*  Shared hook for webhook data                                               */
/* -------------------------------------------------------------------------- */

function useWebhooks(siteId: string) {
  const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!siteId) return;

    const q = query(collection(db!, `sites/${siteId}/webhooks`));
    const unsub = onSnapshot(q, (snapshot) => {
      const items: WebhookData[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          url: data.url || '',
          name: data.name || '',
          events: data.events || [],
          enabled: data.enabled ?? true,
          secret: data.secret || '',
          createdAt: data.createdAt?.toDate?.() || null,
          createdBy: data.createdBy || '',
          lastTriggered: data.lastTriggered?.toDate?.() || null,
          lastStatus: data.lastStatus || 0,
          failCount: data.failCount || 0,
        };
      });
      setWebhooks(items);
      setLoading(false);
    });

    return () => unsub();
  }, [siteId]);

  return { webhooks, loading };
}

/* -------------------------------------------------------------------------- */
/*  Webhook list (renders inline on the page)                                  */
/* -------------------------------------------------------------------------- */

export function WebhookList({ siteId }: { siteId: string }) {
  const { webhooks, loading } = useWebhooks(siteId);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [editingWebhook, setEditingWebhook] = useState<WebhookData | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  const openEdit = (webhook: WebhookData) => {
    setEditingWebhook(webhook);
    setEditName(webhook.name);
    setEditUrl(webhook.url);
    setEditEvents([...webhook.events]);
  };

  const handleEditSave = async () => {
    if (!editingWebhook || !editName.trim() || !editUrl.trim()) {
      toast.error('name and URL are required');
      return;
    }
    if (!editUrl.startsWith('https://')) {
      toast.error('URL must start with https://');
      return;
    }
    if (editEvents.length === 0) {
      toast.error('select at least one event');
      return;
    }
    setEditSaving(true);
    try {
      const ref = doc(db!, `sites/${siteId}/webhooks`, editingWebhook.id);
      await updateDoc(ref, { name: editName.trim(), url: editUrl.trim(), events: editEvents });
      toast.success('webhook updated');
      setEditingWebhook(null);
    } catch {
      toast.error('failed to update webhook');
    } finally {
      setEditSaving(false);
    }
  };

  const toggleEditEvent = (eventId: string) => {
    setEditEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  const handleToggle = async (webhook: WebhookData) => {
    try {
      const ref = doc(db!, `sites/${siteId}/webhooks`, webhook.id);
      await updateDoc(ref, { enabled: !webhook.enabled, failCount: 0 });
      toast.success(webhook.enabled ? 'webhook disabled' : 'webhook enabled');
    } catch {
      toast.error('failed to update webhook');
    }
  };

  const handleDelete = async (webhookId: string) => {
    setDeletingId(webhookId);
    try {
      await deleteDoc(doc(db!, `sites/${siteId}/webhooks`, webhookId));
      toast.success('webhook deleted');
      setDeleteConfirmId(null);
    } catch {
      toast.error('failed to delete webhook');
    } finally {
      setDeletingId(null);
    }
  };

  const handleTest = async (webhook: WebhookData) => {
    setTestingId(webhook.id);
    try {
      const res = await fetch('/api/webhooks/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookId: webhook.id, siteId }),
      });
      const data = await res.json();

      if (data.success) {
        toast.success(`test delivered (HTTP ${data.status})`);
      } else if (data.error) {
        toast.error(`test failed: ${data.error}`);
      } else {
        toast.error(`test failed with HTTP ${data.status}`);
      }
    } catch {
      toast.error('failed to send test');
    } finally {
      setTestingId(null);
    }
  };

  const copySecret = (secret: string) => {
    navigator.clipboard.writeText(secret);
    toast.success('secret copied to clipboard');
  };

  const getStatusBadge = (webhook: WebhookData) => {
    if (!webhook.lastTriggered) {
      return <Badge variant="outline" className="text-muted-foreground border-border">never triggered</Badge>;
    }
    if (webhook.failCount >= 10) {
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">auto-disabled</Badge>;
    }
    if (webhook.lastStatus >= 200 && webhook.lastStatus < 300) {
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle className="h-3 w-3 mr-1" />{webhook.lastStatus}</Badge>;
    }
    if (webhook.lastStatus === 0) {
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30"><XCircle className="h-3 w-3 mr-1" />network error</Badge>;
    }
    return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30"><AlertTriangle className="h-3 w-3 mr-1" />{webhook.lastStatus}</Badge>;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>loading webhooks...</span>
      </div>
    );
  }

  if (webhooks.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Webhook className="h-16 w-16 mx-auto mb-4 opacity-30" />
        <p className="text-lg">no webhooks configured</p>
        <p className="text-sm mt-1">add a webhook to receive event notifications via slack, discord, or any HTTPS endpoint</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {webhooks.map((webhook) => (
        <div
          key={webhook.id}
          className={`flex items-center gap-4 p-4 rounded-lg border border-border bg-card ${!webhook.enabled ? 'opacity-50' : ''}`}
        >
          <Switch
            checked={webhook.enabled}
            onCheckedChange={() => handleToggle(webhook)}
          />

          {/* Left: name inline, url + pills stacked below */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-foreground font-medium">{webhook.name}</span>
              {webhook.url.includes('hooks.slack.com') && (
                <Badge className="bg-[#4A154B]/20 text-[#E01E5A] border-[#4A154B]/40 text-[10px] flex-shrink-0">slack</Badge>
              )}
              {webhook.url.includes('discord.com/api/webhooks') && (
                <Badge className="bg-[#5865F2]/20 text-[#5865F2] border-[#5865F2]/40 text-[10px] flex-shrink-0">discord</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground font-mono truncate mb-1.5">{webhook.url}</p>
            <div className="flex flex-wrap gap-1.5">
              {webhook.events.map((evt) => (
                <Badge key={evt} variant="outline" className="text-xs border-border">
                  {evt.replace('.', ' ')}
                </Badge>
              ))}
            </div>
          </div>

          {/* Center-right: status + date */}
          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="text-right">
              <div>{getStatusBadge(webhook)}</div>
              {webhook.failCount > 0 && webhook.failCount < 10 && (
                <p className="text-[10px] text-amber-400 mt-0.5">{webhook.failCount} failures</p>
              )}
            </div>
            <span className="text-xs text-muted-foreground w-36 text-right">
              {webhook.lastTriggered
                ? webhook.lastTriggered.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
                : '—'}
            </span>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleTest(webhook)}
              disabled={testingId === webhook.id || !webhook.enabled}
              className="text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              test
              {testingId === webhook.id ? (
                <Loader2 className="h-3.5 w-3.5 ml-1 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5 ml-1" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => openEdit(webhook)}
              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {deleteConfirmId === webhook.id ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete(webhook.id)}
                  disabled={deletingId === webhook.id}
                  className="cursor-pointer"
                >
                  {deletingId === webhook.id ? 'deleting...' : 'confirm'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteConfirmId(null)}
                  className="bg-secondary border border-border cursor-pointer"
                >
                  cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteConfirmId(webhook.id)}
                className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      ))}

      {/* Edit webhook dialog */}
      <Dialog open={!!editingWebhook} onOpenChange={(open) => { if (!open) setEditingWebhook(null); }}>
        <DialogContent className="bg-background border-border max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              edit webhook
            </DialogTitle>
            <DialogDescription>
              update webhook configuration. the signing secret cannot be changed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>name</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-2">
              <Label>URL (https required)</Label>
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-2">
              <Label>events</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SUPPORTED_EVENTS.map((evt) => (
                  <label
                    key={evt.id}
                    className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={editEvents.includes(evt.id)}
                      onCheckedChange={() => toggleEditEvent(evt.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium text-foreground">{evt.label}</p>
                      <p className="text-xs text-muted-foreground">{evt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditingWebhook(null)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button onClick={handleEditSave} disabled={editSaving} className="cursor-pointer">
              {editSaving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Pencil className="h-4 w-4 mr-2" />
              )}
              save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Add webhook dialog (only for creating new webhooks)                        */
/* -------------------------------------------------------------------------- */

interface AddWebhookDialogProps {
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddWebhookDialog({ siteId, open, onOpenChange }: AddWebhookDialogProps) {
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['machine.offline', 'process.crashed']);
  const [saving, setSaving] = useState(false);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setNewName('');
      setNewUrl('');
      setNewEvents(['machine.offline', 'process.crashed']);
    }
  }, [open]);

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !newUrl.trim()) {
      toast.error('name and URL are required');
      return;
    }

    if (!newUrl.startsWith('https://')) {
      toast.error('URL must start with https://');
      return;
    }

    if (newEvents.length === 0) {
      toast.error('select at least one event');
      return;
    }

    setSaving(true);
    try {
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      const secret = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');

      const webhookRef = doc(collection(db!, `sites/${siteId}/webhooks`));
      await setDoc(webhookRef, {
        url: newUrl.trim(),
        name: newName.trim(),
        events: newEvents,
        enabled: true,
        secret,
        createdAt: new Date(),
        createdBy: '',
        lastTriggered: null,
        lastStatus: 0,
        failCount: 0,
      });

      setGeneratedSecret(secret);
      onOpenChange(false);
      toast.success('webhook created');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to create webhook';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [siteId, newName, newUrl, newEvents, onOpenChange]);

  const toggleEventSelection = (eventId: string) => {
    setNewEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background border-border max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              add webhook
            </DialogTitle>
            <DialogDescription>
              configure a webhook URL to receive JSON event payloads with HMAC-SHA256 signatures.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>name</Label>
              <Input
                placeholder='e.g. "Slack #alerts"'
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-2">
              <Label>URL (https required)</Label>
              <Input
                placeholder="https://hooks.slack.com/services/..."
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="bg-background border-border"
              />
              {newUrl.includes('hooks.slack.com') && (
                <Badge className="bg-[#4A154B]/20 text-[#E01E5A] border-[#4A154B]/40 text-xs">
                  slack detected — payload will be auto-formatted
                </Badge>
              )}
              {newUrl.includes('discord.com/api/webhooks') && (
                <Badge className="bg-[#5865F2]/20 text-[#5865F2] border-[#5865F2]/40 text-xs">
                  discord detected — payload will be auto-formatted
                </Badge>
              )}
            </div>

            <div className="space-y-2">
              <Label>events</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SUPPORTED_EVENTS.map((evt) => (
                  <label
                    key={evt.id}
                    className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={newEvents.includes(evt.id)}
                      onCheckedChange={() => toggleEventSelection(evt.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium text-foreground">{evt.label}</p>
                      <p className="text-xs text-muted-foreground">{evt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button onClick={handleAdd} disabled={saving} className="cursor-pointer">
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              create webhook
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generated secret dialog */}
      <Dialog open={!!generatedSecret} onOpenChange={() => setGeneratedSecret(null)}>
        <DialogContent className="bg-background border-border">
          <DialogHeader>
            <DialogTitle>webhook created</DialogTitle>
            <DialogDescription>
              save this signing secret — it will not be shown again in full.
              use it to verify webhook signatures on the receiving end.
            </DialogDescription>
          </DialogHeader>
          <div className="p-3 bg-muted rounded-lg">
            <code className="text-sm font-mono text-foreground break-all">{generatedSecret}</code>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (generatedSecret) navigator.clipboard.writeText(generatedSecret);
                toast.success('secret copied');
              }}
              className="border-border hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <Copy className="h-4 w-4 mr-2" />
              copy secret
            </Button>
            <Button onClick={() => setGeneratedSecret(null)} className="cursor-pointer">done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
