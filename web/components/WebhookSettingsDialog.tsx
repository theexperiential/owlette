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
  { id: 'machine.offline', label: 'Machine Offline', description: 'Machine stops sending heartbeats' },
  { id: 'process.crashed', label: 'Process Crashed', description: 'A monitored process crashes' },
  { id: 'process.restarted', label: 'Process Restarted', description: 'A monitored process is restarted' },
  { id: 'machine.online', label: 'Machine Online', description: 'Machine comes back online (future)' },
  { id: 'deployment.completed', label: 'Deployment Completed', description: 'Software deployment succeeds (future)' },
  { id: 'deployment.failed', label: 'Deployment Failed', description: 'Software deployment fails (future)' },
];

interface WebhookSettingsDialogProps {
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function WebhookSettingsDialog({ siteId, open, onOpenChange }: WebhookSettingsDialogProps) {
  const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['machine.offline', 'process.crashed']);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);

  // Listen to webhooks subcollection
  useEffect(() => {
    if (!siteId || !open) return;

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
  }, [siteId, open]);

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !newUrl.trim()) {
      toast.error('Name and URL are required');
      return;
    }

    if (!newUrl.startsWith('https://')) {
      toast.error('URL must start with https://');
      return;
    }

    if (newEvents.length === 0) {
      toast.error('Select at least one event');
      return;
    }

    setSaving(true);
    try {
      // Generate secret client-side (it's visible to the admin who creates it)
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
        createdBy: '', // filled by security rules context
        lastTriggered: null,
        lastStatus: 0,
        failCount: 0,
      });

      setGeneratedSecret(secret);
      setNewName('');
      setNewUrl('');
      setNewEvents(['machine.offline', 'process.crashed']);
      setShowAddForm(false);
      toast.success('Webhook created');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to create webhook';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [siteId, newName, newUrl, newEvents]);

  const handleToggle = async (webhook: WebhookData) => {
    try {
      const ref = doc(db!, `sites/${siteId}/webhooks`, webhook.id);
      await updateDoc(ref, { enabled: !webhook.enabled, failCount: 0 });
      toast.success(webhook.enabled ? 'Webhook disabled' : 'Webhook enabled');
    } catch {
      toast.error('Failed to update webhook');
    }
  };

  const handleDelete = async (webhookId: string) => {
    setDeletingId(webhookId);
    try {
      await deleteDoc(doc(db!, `sites/${siteId}/webhooks`, webhookId));
      toast.success('Webhook deleted');
      setDeleteConfirmId(null);
    } catch {
      toast.error('Failed to delete webhook');
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
        toast.success(`Test delivered (HTTP ${data.status})`);
      } else if (data.error) {
        toast.error(`Test failed: ${data.error}`);
      } else {
        toast.error(`Test failed with HTTP ${data.status}`);
      }
    } catch {
      toast.error('Failed to send test');
    } finally {
      setTestingId(null);
    }
  };

  const copySecret = (secret: string) => {
    navigator.clipboard.writeText(secret);
    toast.success('Secret copied to clipboard');
  };

  const toggleEventSelection = (eventId: string) => {
    setNewEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  const getStatusBadge = (webhook: WebhookData) => {
    if (!webhook.lastTriggered) {
      return <Badge variant="outline" className="text-muted-foreground border-border">Never triggered</Badge>;
    }
    if (webhook.failCount >= 10) {
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Auto-disabled</Badge>;
    }
    if (webhook.lastStatus >= 200 && webhook.lastStatus < 300) {
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle className="h-3 w-3 mr-1" />{webhook.lastStatus}</Badge>;
    }
    if (webhook.lastStatus === 0) {
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30"><XCircle className="h-3 w-3 mr-1" />Network Error</Badge>;
    }
    return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30"><AlertTriangle className="h-3 w-3 mr-1" />{webhook.lastStatus}</Badge>;
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background border-border max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              Webhook Settings
            </DialogTitle>
            <DialogDescription>
              Configure webhook URLs to receive event notifications for this site.
              Webhooks deliver JSON payloads with HMAC-SHA256 signatures.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading webhooks...</div>
          ) : (
            <div className="space-y-4">
              {/* Existing webhooks */}
              {webhooks.length === 0 && !showAddForm && (
                <div className="text-center py-8 text-muted-foreground">
                  <Webhook className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No webhooks configured</p>
                  <p className="text-sm mt-1">Add a webhook to receive event notifications</p>
                </div>
              )}

              {webhooks.map((webhook) => (
                <Card key={webhook.id} className={`bg-card border-border ${!webhook.enabled ? 'opacity-60' : ''}`}>
                  <CardContent className="p-4 space-y-3">
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <Switch
                          checked={webhook.enabled}
                          onCheckedChange={() => handleToggle(webhook)}
                        />
                        <div className="min-w-0">
                          <p className="font-medium text-foreground truncate">{webhook.name}</p>
                          <p className="text-xs text-muted-foreground truncate font-mono">{webhook.url}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {getStatusBadge(webhook)}
                      </div>
                    </div>

                    {/* Events */}
                    <div className="flex flex-wrap gap-1">
                      {webhook.events.map((evt) => (
                        <Badge key={evt} variant="outline" className="text-xs border-border">
                          {evt}
                        </Badge>
                      ))}
                    </div>

                    {/* Fail count warning */}
                    {webhook.failCount > 0 && webhook.failCount < 10 && (
                      <p className="text-xs text-amber-400">
                        {webhook.failCount} consecutive failure(s) — auto-disables at 10
                      </p>
                    )}

                    {/* Last triggered */}
                    {webhook.lastTriggered && (
                      <p className="text-xs text-muted-foreground">
                        Last triggered: {webhook.lastTriggered.toLocaleString()}
                      </p>
                    )}

                    {/* Secret */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Secret:</span>
                      <code className="text-xs font-mono text-muted-foreground">
                        {revealedSecrets.has(webhook.id)
                          ? webhook.secret
                          : '••••••••••••••••'}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => {
                          setRevealedSecrets((prev) => {
                            const next = new Set(prev);
                            if (next.has(webhook.id)) next.delete(webhook.id);
                            else next.add(webhook.id);
                            return next;
                          });
                        }}
                      >
                        {revealedSecrets.has(webhook.id) ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copySecret(webhook.secret)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTest(webhook)}
                        disabled={testingId === webhook.id || !webhook.enabled}
                        className="border-border"
                      >
                        {testingId === webhook.id ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3 mr-1" />
                        )}
                        Test
                      </Button>
                      {deleteConfirmId === webhook.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDelete(webhook.id)}
                            disabled={deletingId === webhook.id}
                          >
                            {deletingId === webhook.id ? 'Deleting...' : 'Confirm Delete'}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDeleteConfirmId(null)}
                            className="border-border"
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(webhook.id)}
                          className="text-red-400 hover:text-red-300 hover:bg-red-950/30"
                        >
                          <Trash2 className="h-3 w-3 mr-1" />
                          Delete
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}

              {/* Add form */}
              {showAddForm && (
                <Card className="bg-card border-accent-cyan/30">
                  <CardContent className="p-4 space-y-4">
                    <div className="space-y-2">
                      <Label>Name</Label>
                      <Input
                        placeholder='e.g. "Slack #alerts"'
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="bg-background border-border"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>URL (HTTPS required)</Label>
                      <Input
                        placeholder="https://hooks.slack.com/services/..."
                        value={newUrl}
                        onChange={(e) => setNewUrl(e.target.value)}
                        className="bg-background border-border"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Events</Label>
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

                    <div className="flex items-center gap-2">
                      <Button onClick={handleAdd} disabled={saving}>
                        {saving ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4 mr-2" />
                        )}
                        Create Webhook
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setShowAddForm(false)}
                        className="border-border"
                      >
                        Cancel
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Add button */}
              {!showAddForm && (
                <Button
                  variant="outline"
                  onClick={() => setShowAddForm(true)}
                  className="w-full border-dashed border-border"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Webhook
                </Button>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} className="border-border">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generated secret dialog */}
      <Dialog open={!!generatedSecret} onOpenChange={() => setGeneratedSecret(null)}>
        <DialogContent className="bg-background border-border">
          <DialogHeader>
            <DialogTitle>Webhook Created</DialogTitle>
            <DialogDescription>
              Save this signing secret — it will not be shown again in full.
              Use it to verify webhook signatures on the receiving end.
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
                toast.success('Secret copied');
              }}
              className="border-border"
            >
              <Copy className="h-4 w-4 mr-2" />
              Copy Secret
            </Button>
            <Button onClick={() => setGeneratedSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
