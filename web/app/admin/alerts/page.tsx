'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Bell, Plus, Trash2, Loader2, Zap, Pencil } from 'lucide-react';
import { toast } from 'sonner';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  severity: 'info' | 'warning' | 'critical';
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const METRICS = [
  { value: 'cpu_percent', label: 'CPU usage (%)' },
  { value: 'memory_percent', label: 'memory usage (%)' },
  { value: 'disk_percent', label: 'disk usage (%)' },
  { value: 'gpu_percent', label: 'GPU usage (%)' },
  { value: 'cpu_temp', label: 'CPU temperature (°C)' },
  { value: 'gpu_temp', label: 'GPU temperature (°C)' },
  { value: 'network_latency', label: 'network latency (ms)' },
  { value: 'network_packet_loss', label: 'packet loss (%)' },
] as const;

const OPERATORS = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
] as const;

const SEVERITIES = ['info', 'warning', 'critical'] as const;

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-blue-600/20 text-blue-400',
  warning: 'bg-yellow-600/20 text-yellow-400',
  critical: 'bg-red-600/20 text-red-400',
};

const PRESET_TEMPLATES: Omit<AlertRule, 'id'>[] = [
  {
    name: 'GPU Overheating',
    metric: 'gpu_temp',
    operator: '>',
    value: 85,
    severity: 'warning',
    channels: ['email', 'webhook'],
    enabled: true,
    cooldownMinutes: 30,
  },
  {
    name: 'Low Disk',
    metric: 'disk_percent',
    operator: '<',
    value: 10,
    severity: 'warning',
    channels: ['email', 'webhook'],
    enabled: true,
    cooldownMinutes: 60,
  },
  {
    name: 'High Memory',
    metric: 'memory_percent',
    operator: '>',
    value: 90,
    severity: 'warning',
    channels: ['email', 'webhook'],
    enabled: true,
    cooldownMinutes: 30,
  },
  {
    name: 'High CPU',
    metric: 'cpu_percent',
    operator: '>',
    value: 95,
    severity: 'critical',
    channels: ['email', 'webhook'],
    enabled: true,
    cooldownMinutes: 30,
  },
];

function generateId(): string {
  return crypto.randomUUID();
}

function getMetricLabel(metric: string): string {
  return METRICS.find((m) => m.value === metric)?.label ?? metric;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AlertsPage() {
  const { user, isAdmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isAdmin);

  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<AlertRule | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formMetric, setFormMetric] = useState('cpu_percent');
  const [formOperator, setFormOperator] = useState<string>('>');
  const [formValue, setFormValue] = useState('');
  const [formSeverity, setFormSeverity] = useState<string>('warning');
  const [formEmail, setFormEmail] = useState(true);
  const [formWebhook, setFormWebhook] = useState(true);
  const [formCooldown, setFormCooldown] = useState('30');

  // Load saved site
  useEffect(() => {
    if (sites.length > 0 && !selectedSiteId) {
      const savedSite = lastSiteId;
      if (savedSite && sites.find((s) => s.id === savedSite)) {
        setSelectedSiteId(savedSite);
      } else {
        setSelectedSiteId(sites[0].id);
      }
    }
  }, [sites, selectedSiteId, lastSiteId]);

  // Fetch alert rules when site changes
  const fetchRules = useCallback(async (siteId: string) => {
    if (!db || !siteId) return;
    setLoading(true);
    try {
      const alertsRef = doc(db, 'sites', siteId, 'settings', 'alerts');
      const snap = await getDoc(alertsRef);
      if (snap.exists() && Array.isArray(snap.data()?.rules)) {
        setRules(snap.data().rules as AlertRule[]);
      } else {
        setRules([]);
      }
    } catch (err: any) {
      console.error('Failed to fetch alert rules:', err);
      toast.error('Failed to load alert rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedSiteId) {
      fetchRules(selectedSiteId);
    }
  }, [selectedSiteId, fetchRules]);

  // Persist rules to Firestore
  const saveRules = async (updatedRules: AlertRule[]) => {
    if (!db || !selectedSiteId) return;
    setSaving(true);
    try {
      const alertsRef = doc(db, 'sites', selectedSiteId, 'settings', 'alerts');
      await setDoc(alertsRef, { rules: updatedRules }, { merge: true });
      setRules(updatedRules);
    } catch (err: any) {
      console.error('Failed to save alert rules:', err);
      toast.error('Failed to save alert rules');
    } finally {
      setSaving(false);
    }
  };

  const handleSiteChange = (siteId: string) => {
    setSelectedSiteId(siteId);
    updateLastSite(siteId);
  };

  // Open create dialog
  const openCreateDialog = () => {
    setEditingRule(null);
    setFormName('');
    setFormMetric('cpu_percent');
    setFormOperator('>');
    setFormValue('');
    setFormSeverity('warning');
    setFormEmail(true);
    setFormWebhook(true);
    setFormCooldown('30');
    setDialogOpen(true);
  };

  // Open edit dialog
  const openEditDialog = (rule: AlertRule) => {
    setEditingRule(rule);
    setFormName(rule.name);
    setFormMetric(rule.metric);
    setFormOperator(rule.operator);
    setFormValue(String(rule.value));
    setFormSeverity(rule.severity);
    setFormEmail(rule.channels.includes('email'));
    setFormWebhook(rule.channels.includes('webhook'));
    setFormCooldown(String(rule.cooldownMinutes));
    setDialogOpen(true);
  };

  // Save rule (create or update)
  const handleSaveRule = async () => {
    if (!formName.trim()) {
      toast.error('Rule name is required');
      return;
    }
    const numValue = parseFloat(formValue);
    if (isNaN(numValue)) {
      toast.error('Threshold value must be a number');
      return;
    }
    const cooldown = parseInt(formCooldown, 10);
    if (isNaN(cooldown) || cooldown < 1) {
      toast.error('Cooldown must be at least 1 minute');
      return;
    }

    const channels: string[] = [];
    if (formEmail) channels.push('email');
    if (formWebhook) channels.push('webhook');
    if (channels.length === 0) {
      toast.error('Select at least one notification channel');
      return;
    }

    const rule: AlertRule = {
      id: editingRule?.id ?? generateId(),
      name: formName.trim(),
      metric: formMetric,
      operator: formOperator as AlertRule['operator'],
      value: numValue,
      severity: formSeverity as AlertRule['severity'],
      channels,
      enabled: editingRule?.enabled ?? true,
      cooldownMinutes: cooldown,
    };

    let updatedRules: AlertRule[];
    if (editingRule) {
      updatedRules = rules.map((r) => (r.id === editingRule.id ? rule : r));
    } else {
      updatedRules = [...rules, rule];
    }

    await saveRules(updatedRules);
    setDialogOpen(false);
    toast.success(editingRule ? 'Rule updated' : 'Rule created');
  };

  // Toggle enabled
  const handleToggleEnabled = async (ruleId: string) => {
    const updatedRules = rules.map((r) =>
      r.id === ruleId ? { ...r, enabled: !r.enabled } : r
    );
    await saveRules(updatedRules);
  };

  // Delete rule
  const handleDeleteConfirm = async () => {
    if (!ruleToDelete) return;
    const updatedRules = rules.filter((r) => r.id !== ruleToDelete.id);
    await saveRules(updatedRules);
    setDeleteDialogOpen(false);
    setRuleToDelete(null);
    toast.success('Rule deleted');
  };

  // Add preset
  const handleAddPreset = async (preset: Omit<AlertRule, 'id'>) => {
    // Check if a rule with the same name already exists
    if (rules.some((r) => r.name === preset.name)) {
      toast.error(`A rule named "${preset.name}" already exists`);
      return;
    }
    const rule: AlertRule = { ...preset, id: generateId() };
    const updatedRules = [...rules, rule];
    await saveRules(updatedRules);
    toast.success(`Preset "${preset.name}" added`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-3 text-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>loading alert rules...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">alerts</h1>
              <p className="text-muted-foreground">
                configure rules to get notified when machine metrics exceed thresholds
              </p>
            </div>
            <div className="flex items-center gap-3">
              {sites.length > 1 && (
                <Select value={selectedSiteId} onValueChange={handleSiteChange}>
                  <SelectTrigger className="w-[180px] border-border bg-card text-foreground">
                    <SelectValue placeholder="select site" />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="hover:bg-accent! hover:text-foreground! cursor-pointer" disabled={saving}>
                    <Zap className="h-4 w-4 mr-2" />
                    presets
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-card border-border text-foreground">
                  {PRESET_TEMPLATES.map((preset) => (
                    <DropdownMenuItem
                      key={preset.name}
                      onClick={() => handleAddPreset(preset)}
                      className="cursor-pointer"
                    >
                      {preset.name} ({preset.metric.replace('_', ' ')} {preset.operator} {preset.value})
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                onClick={openCreateDialog}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                disabled={saving}
              >
                <Plus className="h-5 w-5 mr-2" />
                create rule
              </Button>
            </div>
          </div>
        </div>

        {/* Empty state */}
        {rules.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Bell className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">no alert rules configured</h3>
            <p className="text-muted-foreground text-sm mb-6 max-w-md">
              create alert rules to get notified when machine metrics like CPU, memory, disk, or
              GPU exceed your defined thresholds.
            </p>
            <div className="flex gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="hover:bg-accent! hover:text-foreground! cursor-pointer">
                    <Zap className="h-4 w-4 mr-2" />
                    add from presets
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="bg-card border-border text-foreground">
                  {PRESET_TEMPLATES.map((preset) => (
                    <DropdownMenuItem
                      key={preset.name}
                      onClick={() => handleAddPreset(preset)}
                      className="cursor-pointer"
                    >
                      {preset.name} ({preset.metric.replace('_', ' ')} {preset.operator} {preset.value})
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                onClick={openCreateDialog}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
              >
                <Plus className="h-4 w-4 mr-2" />
                create rule
              </Button>
            </div>
          </div>
        )}

        {/* Rules list */}
        {rules.length > 0 && (
          <div className="space-y-3">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card"
              >
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={() => handleToggleEnabled(rule.id)}
                  disabled={saving}
                />
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => openEditDialog(rule)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-foreground font-medium">{rule.name}</span>
                    <Badge className={`${SEVERITY_COLORS[rule.severity]} text-[10px]`}>
                      {rule.severity}
                    </Badge>
                    {!rule.enabled && (
                      <Badge className="bg-muted text-muted-foreground text-[10px]">disabled</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {getMetricLabel(rule.metric)} {rule.operator} {rule.value}
                    {' · '}
                    {rule.channels.join(', ')}
                    {' · '}
                    cooldown {rule.cooldownMinutes}m
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openEditDialog(rule)}
                  disabled={saving}
                  className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRuleToDelete(rule);
                    setDeleteDialogOpen(true);
                  }}
                  disabled={saving}
                  className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-card border-border text-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingRule ? 'edit rule' : 'create alert rule'}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {editingRule
                ? 'update the alert rule configuration.'
                : 'set up a new threshold alert rule.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="rule-name">name</Label>
              <Input
                id="rule-name"
                placeholder="e.g. GPU Overheating"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            {/* Metric */}
            <div className="space-y-2">
              <Label>metric</Label>
              <Select value={formMetric} onValueChange={setFormMetric}>
                <SelectTrigger className="bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  {METRICS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Operator + Value */}
            <div className="flex gap-3">
              <div className="space-y-2 w-24">
                <Label>operator</Label>
                <Select value={formOperator} onValueChange={setFormOperator}>
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border text-foreground">
                    {OPERATORS.map((op) => (
                      <SelectItem key={op.value} value={op.value}>
                        {op.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="rule-value">threshold</Label>
                <Input
                  id="rule-value"
                  type="number"
                  placeholder="85"
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  className="bg-background border-border"
                />
              </div>
            </div>

            {/* Severity */}
            <div className="space-y-2">
              <Label>severity</Label>
              <Select value={formSeverity} onValueChange={setFormSeverity}>
                <SelectTrigger className="bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Channels */}
            <div className="space-y-2">
              <Label>notification channels</Label>
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="channel-email"
                    checked={formEmail}
                    onCheckedChange={(checked) => setFormEmail(checked === true)}
                  />
                  <Label htmlFor="channel-email" className="font-normal cursor-pointer">
                    email
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="channel-webhook"
                    checked={formWebhook}
                    onCheckedChange={(checked) => setFormWebhook(checked === true)}
                  />
                  <Label htmlFor="channel-webhook" className="font-normal cursor-pointer">
                    webhook
                  </Label>
                </div>
              </div>
            </div>

            {/* Cooldown */}
            <div className="space-y-2">
              <Label htmlFor="rule-cooldown">cooldown (minutes)</Label>
              <Input
                id="rule-cooldown"
                type="number"
                min={1}
                placeholder="30"
                value={formCooldown}
                onChange={(e) => setFormCooldown(e.target.value)}
                className="bg-background border-border"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleSaveRule}
              disabled={saving}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingRule ? 'save' : 'create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>delete alert rule</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to delete &quot;{ruleToDelete?.name}&quot;? this action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleDeleteConfirm}
              disabled={saving}
              className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
