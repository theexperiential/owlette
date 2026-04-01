'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EyeIcon, EyeOffIcon, AlertTriangle, Shield, Brain, Check, Loader2, User, Bell, Mail, Trash2, Key, Copy, Plus, X, Code } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { PasskeyManager } from '@/components/PasskeyManager';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { TimezoneSelect } from '@/components/TimezoneSelect';

type SettingsSection = 'profile' | 'preferences' | 'notifications' | 'cortex' | 'security' | 'api' | 'danger';

const AVAILABLE_MODELS: Record<'anthropic' | 'openai', { id: string; name: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-0', name: 'Claude Opus 4' },
  ],
  openai: [
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'o3', name: 'o3' },
    { id: 'o4-mini', name: 'o4 Mini' },
  ],
};

const SECTIONS: { id: SettingsSection; label: string; icon: React.ElementType }[] = [
  { id: 'profile', label: 'profile', icon: User },
  { id: 'preferences', label: 'preferences', icon: Bell },
  { id: 'notifications', label: 'notifications', icon: Mail },
  { id: 'cortex', label: 'cortex', icon: Brain },
  { id: 'security', label: 'security', icon: Shield },
  { id: 'api', label: 'api', icon: Code },
  { id: 'danger', label: 'danger zone', icon: Trash2 },
];

interface ApiKeyEntry {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface AccountSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
}

export function AccountSettingsDialog({ open, onOpenChange, initialSection }: AccountSettingsDialogProps) {
  const { user, userPreferences, updateUserProfile, updatePassword, updateUserPreferences, deleteAccount } = useAuth();
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection || 'profile');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [temperatureUnit, setTemperatureUnit] = useState<'C' | 'F'>('C');
  const [timezone, setTimezone] = useState('UTC');
  const [timeFormat, setTimeFormat] = useState<'12h' | '24h'>('12h');
  const [healthAlerts, setHealthAlerts] = useState(true);
  const [processAlerts, setProcessAlerts] = useState(true);
  const [alertCcEmails, setAlertCcEmails] = useState<string[]>([]);
  const [newCcEmail, setNewCcEmail] = useState('');
  const [ccEmailError, setCcEmailError] = useState('');
  const [loading, setLoading] = useState(false);

  // Password change state
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  // LLM API key state
  const [llmProvider, setLlmProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [llmModels, setLlmModels] = useState<{ id: string; name: string }[]>([]);
  const [llmModelsLoading, setLlmModelsLoading] = useState(false);

  // API key state
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [confirmRevokeKeyId, setConfirmRevokeKeyId] = useState<string | null>(null);

  // Account deletion state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Fetch available models from provider API
  const fetchLlmModels = async (provider: string) => {
    setLlmModelsLoading(true);
    try {
      const res = await fetch(`/api/settings/llm-models?provider=${provider}`);
      if (res.ok) {
        const data = await res.json();
        setLlmModels(data.models || []);
      }
    } catch {
      // Fall back to hardcoded list (already in state)
    }
    setLlmModelsLoading(false);
  };

  // Navigate to initial section when dialog opens
  useEffect(() => {
    if (open && initialSection) {
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);

  // Load form state when dialog opens
  useEffect(() => {
    if (open) {
      if (user?.displayName) {
        const names = user.displayName.split(' ');
        if (names.length >= 2) {
          setFirstName(names[0]);
          setLastName(names.slice(1).join(' '));
        } else {
          setFirstName(names[0]);
          setLastName('');
        }
      }

      setTemperatureUnit(userPreferences.temperatureUnit);
      setTimezone(userPreferences.timezone || getBrowserTimezone());
      setTimeFormat(userPreferences.timeFormat || '12h');
      setHealthAlerts(userPreferences.healthAlerts);
      setProcessAlerts(userPreferences.processAlerts);
      setAlertCcEmails(userPreferences.alertCcEmails || []);
      setNewCcEmail('');
      setCcEmailError('');

      fetch('/api/settings/llm-key')
        .then((res) => res.json())
        .then((data) => {
          setLlmConfigured(data.configured || false);
          if (data.provider) setLlmProvider(data.provider);
          if (data.model) setLlmModel(data.model);
          if (data.configured) {
            fetchLlmModels(data.provider || 'anthropic');
          }
        })
        .catch(() => {});

      // Load API keys
      fetch('/api/admin/keys')
        .then((res) => res.json())
        .then((data) => {
          if (data.success) setApiKeys(data.keys || []);
        })
        .catch(() => {});
    } else {
      setFirstName('');
      setLastName('');
      setTemperatureUnit('C');
      setTimezone(getBrowserTimezone());
      setTimeFormat('12h');
      setHealthAlerts(true);
      setProcessAlerts(true);
      setAlertCcEmails([]);
      setNewCcEmail('');
      setCcEmailError('');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
      setShowPasswordSection(false);
      setShowDeleteConfirm(false);
      setDeletePassword('');
      setLlmApiKey('');
      setShowLlmKey(false);
      setApiKeys([]);
      setNewKeyName('');
      setCreatedKey(null);
      setCreatingKey(false);
      setActiveSection('profile');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.displayName, userPreferences.temperatureUnit, userPreferences.timezone, userPreferences.timeFormat, userPreferences.healthAlerts, userPreferences.processAlerts, JSON.stringify(userPreferences.alertCcEmails)]);

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
  };

  const handleAddCcEmail = () => {
    const email = newCcEmail.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setCcEmailError('please enter a valid email address');
      return;
    }
    if (email === user?.email?.toLowerCase()) {
      setCcEmailError('this is already your primary alert email');
      return;
    }
    if (alertCcEmails.includes(email)) {
      setCcEmailError('this email is already added');
      return;
    }
    if (alertCcEmails.length >= 5) {
      setCcEmailError('maximum of 5 CC addresses');
      return;
    }
    setAlertCcEmails(prev => [...prev, email]);
    setNewCcEmail('');
    setCcEmailError('');
  };

  const validatePassword = (): boolean => {
    setPasswordError('');
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All password fields are required');
      return false;
    }
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters');
      return false;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return false;
    }
    if (newPassword === currentPassword) {
      setPasswordError('New password must be different from current password');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    setLoading(true);
    setPasswordError('');
    try {
      if (firstName || lastName) {
        await updateUserProfile(firstName, lastName);
      }
      const prefsChanged = temperatureUnit !== userPreferences.temperatureUnit
        || timezone !== userPreferences.timezone
        || timeFormat !== (userPreferences.timeFormat || '12h')
        || healthAlerts !== userPreferences.healthAlerts
        || processAlerts !== userPreferences.processAlerts
        || JSON.stringify(alertCcEmails) !== JSON.stringify(userPreferences.alertCcEmails || []);
      if (prefsChanged) {
        await updateUserPreferences({ temperatureUnit, timezone, timeFormat, healthAlerts, processAlerts, alertCcEmails });
      }
      if (showPasswordSection && (currentPassword || newPassword || confirmPassword)) {
        if (!validatePassword()) {
          setLoading(false);
          return;
        }
        await updatePassword(currentPassword, newPassword);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setShowPasswordSection(false);
      }
      onOpenChange(false);
    } catch (error) {
      // Error already handled by AuthContext with toast
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) return;
    setDeleting(true);
    try {
      await deleteAccount(deletePassword);
      setShowDeleteConfirm(false);
      onOpenChange(false);
    } catch (error) {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-secondary text-white sm:max-w-4xl p-0 gap-0 max-h-[90dvh]">
        <VisuallyHidden>
          <DialogTitle>account settings</DialogTitle>
        </VisuallyHidden>
        <div className="flex flex-col sm:flex-row sm:min-h-[480px] min-h-0 max-h-[85dvh]">
          {/* Mobile: horizontal scrollable tabs */}
          <nav className="sm:hidden flex overflow-x-auto border-b border-border bg-card/50 p-1.5 gap-1 flex-shrink-0">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors cursor-pointer flex-shrink-0 ${
                  activeSection === id
                    ? 'bg-accent text-white'
                    : id === 'danger'
                      ? 'text-red-400 hover:bg-red-950/30'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Desktop: vertical sidebar */}
          <nav className="hidden sm:flex w-48 border-r border-border bg-card/50 p-2 flex-col gap-0.5 flex-shrink-0">
            <div className="px-3 py-2.5 mb-1">
              <h2 className="text-sm font-semibold text-white">settings</h2>
            </div>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                  activeSection === id
                    ? 'bg-accent text-white'
                    : id === 'danger'
                      ? 'text-red-400 hover:bg-red-950/30'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {/* ─── Profile ─── */}
              {activeSection === 'profile' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-white">profile</h3>
                    <p className="text-xs text-muted-foreground mt-1">your personal information</p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="settings-firstName" className="text-white">first name</Label>
                      <Input
                        id="settings-firstName"
                        type="text"
                        placeholder="first name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="border-border bg-background text-white"
                        disabled={loading}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="settings-lastName" className="text-white">last name</Label>
                      <Input
                        id="settings-lastName"
                        type="text"
                        placeholder="last name"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="border-border bg-background text-white"
                        disabled={loading}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-white">email</Label>
                    <Input
                      type="email"
                      value={user?.email || ''}
                      className="border-border bg-background text-muted-foreground"
                      disabled
                      readOnly
                    />
                    <p className="text-xs text-muted-foreground">email cannot be changed</p>
                  </div>
                </div>
              )}

              {/* ─── Preferences ─── */}
              {activeSection === 'preferences' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-white">preferences</h3>
                    <p className="text-xs text-muted-foreground mt-1">dashboard display settings</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timezone" className="text-white">timezone</Label>
                    <TimezoneSelect
                      id="timezone"
                      value={timezone}
                      onValueChange={(value: string) => setTimezone(value)}
                      disabled={loading}
                      className="border-border bg-background text-white hover:bg-secondary w-72"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="temperatureUnit" className="text-white">temperature unit</Label>
                    <Select
                      value={temperatureUnit}
                      onValueChange={(value: 'C' | 'F') => setTemperatureUnit(value)}
                      disabled={loading}
                    >
                      <SelectTrigger id="temperatureUnit" className="border-border bg-background text-white hover:bg-secondary w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-secondary text-white">
                        <SelectItem value="C" className="cursor-pointer hover:bg-muted">Celsius (°C)</SelectItem>
                        <SelectItem value="F" className="cursor-pointer hover:bg-muted">Fahrenheit (°F)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timeFormat" className="text-white">time format</Label>
                    <Select
                      value={timeFormat}
                      onValueChange={(value: '12h' | '24h') => setTimeFormat(value)}
                      disabled={loading}
                    >
                      <SelectTrigger id="timeFormat" className="border-border bg-background text-white hover:bg-secondary w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-secondary text-white">
                        <SelectItem value="12h" className="cursor-pointer hover:bg-muted">12-hour (AM/PM)</SelectItem>
                        <SelectItem value="24h" className="cursor-pointer hover:bg-muted">24-hour</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* ─── Notifications ─── */}
              {activeSection === 'notifications' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-white">notifications</h3>
                    <p className="text-xs text-muted-foreground mt-1">configure email alerts for machine and process events</p>
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="healthAlerts" className="text-white">machine offline alerts</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when machines go offline</p>
                    </div>
                    <Switch
                      id="healthAlerts"
                      checked={healthAlerts}
                      onCheckedChange={setHealthAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="processAlerts" className="text-white">process crash alerts</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when monitored processes crash or fail to start</p>
                    </div>
                    <Switch
                      id="processAlerts"
                      checked={processAlerts}
                      onCheckedChange={setProcessAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="rounded-md border border-border bg-card/50 p-4 space-y-3">
                    <div className="space-y-0.5">
                      <Label className="text-white">alert email</Label>
                      <p className="text-xs text-muted-foreground">
                        alerts are sent to <span className="text-white font-medium">{user?.email}</span>
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-white text-xs">additional CC recipients</Label>
                      {alertCcEmails.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {alertCcEmails.map((email) => (
                            <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/30 text-xs text-white">
                              {email}
                              <button
                                type="button"
                                onClick={() => setAlertCcEmails(prev => prev.filter(e => e !== email))}
                                disabled={loading}
                                className="cursor-pointer text-muted-foreground hover:text-white"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Input
                          type="email"
                          placeholder="colleague@example.com"
                          value={newCcEmail}
                          onChange={(e) => { setNewCcEmail(e.target.value); setCcEmailError(''); }}
                          className="border-border bg-background text-white flex-1"
                          disabled={loading}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCcEmail(); } }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleAddCcEmail}
                          disabled={loading || !newCcEmail.trim()}
                          className="border-border text-white hover:bg-secondary"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {ccEmailError && <p className="text-xs text-red-400">{ccEmailError}</p>}
                      <p className="text-[11px] text-muted-foreground">these addresses will be CC&apos;d on all alert emails. max 5.</p>
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Cortex ─── */}
              {activeSection === 'cortex' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-white flex items-center gap-2">
                      cortex
                      {llmConfigured && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400 flex items-center gap-1 font-normal">
                          <Check className="h-3 w-3" /> connected
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      connect an LLM provider to power Owlette&apos;s intelligence layer. query machines,
                      run diagnostics, and manage your fleet through natural language.
                    </p>
                  </div>

                  <div className="space-y-4 rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-2">
                      <Label htmlFor="llmProvider" className="text-white">provider</Label>
                      <Select
                        value={llmProvider}
                        onValueChange={(value: 'anthropic' | 'openai') => {
                          setLlmProvider(value);
                          setLlmModel('');
                          setLlmModels([]);
                          if (llmConfigured) fetchLlmModels(value);
                        }}
                        disabled={llmSaving}
                      >
                        <SelectTrigger id="llmProvider" className="border-border bg-background text-white hover:bg-secondary w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-secondary text-white">
                          <SelectItem value="anthropic" className="cursor-pointer hover:bg-muted">Anthropic (Claude)</SelectItem>
                          <SelectItem value="openai" className="cursor-pointer hover:bg-muted">OpenAI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="llmModel" className="text-white">model</Label>
                      {(() => {
                        const models = llmModels.length > 0 ? llmModels : AVAILABLE_MODELS[llmProvider];
                        const defaultModel = models[0]?.id || '';
                        return (
                          <Select
                            value={llmModel || defaultModel}
                            onValueChange={setLlmModel}
                            disabled={llmSaving || llmModelsLoading}
                          >
                            <SelectTrigger id="llmModel" className="border-border bg-background text-white hover:bg-secondary w-64">
                              {llmModelsLoading ? (
                                <span className="flex items-center gap-2 text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" /> loading models…
                                </span>
                              ) : (
                                <SelectValue />
                              )}
                            </SelectTrigger>
                            <SelectContent className="border-border bg-secondary text-white max-h-64">
                              {models.map((m) => (
                                <SelectItem key={m.id} value={m.id} className="cursor-pointer hover:bg-muted">
                                  {m.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      })()}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="llmApiKey" className="text-white flex items-center gap-2">
                        <Key className="h-3.5 w-3.5" />
                        api key
                      </Label>
                      <div className="relative">
                        <Input
                          id="llmApiKey"
                          type={showLlmKey ? 'text' : 'password'}
                          placeholder={llmConfigured ? '••••••••••••••••••••••••' : llmProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          className="border-border bg-background pr-10 text-white"
                          disabled={llmSaving}
                        />
                        <button
                          type="button"
                          onClick={() => setShowLlmKey(!showLlmKey)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-white"
                        >
                          {showLlmKey ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                        </button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        your key is encrypted with AES-256 and never leaves the server.
                      </p>
                    </div>

                    <div className="flex gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={async () => {
                          if (!llmApiKey) return;
                          setLlmSaving(true);
                          try {
                            const res = await fetch('/api/settings/llm-key', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                provider: llmProvider,
                                apiKey: llmApiKey,
                                model: llmModel || (llmModels.length > 0 ? llmModels[0].id : AVAILABLE_MODELS[llmProvider][0].id),
                              }),
                            });
                            if (res.ok) {
                              setLlmConfigured(true);
                              setLlmApiKey('');
                              toast.success('API key saved');
                              fetchLlmModels(llmProvider);
                            } else {
                              const err = await res.json().catch(() => ({}));
                              toast.error(err.error || 'Failed to save API key');
                            }
                          } catch (e) {
                            toast.error(`Failed to save API key: ${e instanceof Error ? e.message : 'Unknown error'}`);
                          }
                          setLlmSaving(false);
                        }}
                        disabled={!llmApiKey || llmSaving}
                        className="cursor-pointer bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 h-8"
                      >
                        {llmSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'save key'}
                      </Button>
                      {llmConfigured && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            setLlmSaving(true);
                            try {
                              await fetch('/api/settings/llm-key', { method: 'DELETE' });
                              setLlmConfigured(false);
                              setLlmApiKey('');
                              toast.success('API key removed');
                            } catch {
                              toast.error('Failed to remove API key');
                            }
                            setLlmSaving(false);
                          }}
                          disabled={llmSaving}
                          className="cursor-pointer border-border text-red-400 hover:bg-muted h-8"
                        >
                          remove key
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Security ─── */}
              {activeSection === 'security' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-white">security</h3>
                    <p className="text-xs text-muted-foreground mt-1">authentication and access control</p>
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div>
                      <p className="text-sm text-white">two-factor authentication</p>
                      <p className="text-xs text-muted-foreground">add an extra layer of security to your account</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="h-8 cursor-pointer border-border text-accent-cyan hover:bg-muted hover:text-accent-cyan"
                    >
                      <Link href="/setup-2fa" onClick={() => onOpenChange(false)}>
                        manage
                      </Link>
                    </Button>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-white">change password</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setShowPasswordSection(!showPasswordSection);
                          setPasswordError('');
                          if (showPasswordSection) {
                            setCurrentPassword('');
                            setNewPassword('');
                            setConfirmPassword('');
                          }
                        }}
                        className="h-8 cursor-pointer border-border text-accent-cyan hover:text-accent-cyan hover:bg-muted"
                        disabled={loading}
                      >
                        {showPasswordSection ? 'cancel' : 'update password'}
                      </Button>
                    </div>

                    {showPasswordSection && (
                      <div className="space-y-3 rounded-md border border-border bg-card/50 p-4">
                        <div className="space-y-2">
                          <Label htmlFor="currentPassword" className="text-white">current password</Label>
                          <div className="relative">
                            <Input
                              id="currentPassword"
                              type={showCurrentPassword ? 'text' : 'password'}
                              placeholder="enter current password"
                              value={currentPassword}
                              onChange={(e) => setCurrentPassword(e.target.value)}
                              className="border-border bg-background pr-10 text-white"
                              disabled={loading}
                            />
                            <button
                              type="button"
                              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-white"
                              disabled={loading}
                            >
                              {showCurrentPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="newPassword" className="text-white">new password</Label>
                          <div className="relative">
                            <Input
                              id="newPassword"
                              type={showNewPassword ? 'text' : 'password'}
                              placeholder="enter new password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              className="border-border bg-background pr-10 text-white"
                              disabled={loading}
                            />
                            <button
                              type="button"
                              onClick={() => setShowNewPassword(!showNewPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-white"
                              disabled={loading}
                            >
                              {showNewPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground">must be at least 6 characters</p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="confirmPassword" className="text-white">confirm new password</Label>
                          <div className="relative">
                            <Input
                              id="confirmPassword"
                              type={showConfirmPassword ? 'text' : 'password'}
                              placeholder="confirm new password"
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                              className="border-border bg-background pr-10 text-white"
                              disabled={loading}
                            />
                            <button
                              type="button"
                              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-white"
                              disabled={loading}
                            >
                              {showConfirmPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>

                        {passwordError && (
                          <div className="rounded-md bg-red-900/20 border border-red-800 p-3">
                            <p className="text-sm text-red-400">{passwordError}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Passkey management */}
                  {user && (
                    <PasskeyManager userId={user.uid} compact />
                  )}
                </div>
              )}

              {/* ─── API ─── */}
              {activeSection === 'api' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-white">API keys</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      create keys for programmatic access to the admin API
                    </p>
                  </div>

                  {/* Show newly created key */}
                  {createdKey && (
                    <div className="relative rounded-md border border-accent-cyan/50 bg-accent-cyan/5 p-4 space-y-2">
                      <button
                        type="button"
                        onClick={() => setCreatedKey(null)}
                        className="absolute top-2.5 right-2.5 cursor-pointer text-muted-foreground hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                      <p className="text-sm text-accent-cyan font-medium pr-6">key created — copy it now, you won&apos;t see it again</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-background rounded px-3 py-2 text-white font-mono break-all select-all">
                          {createdKey}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            navigator.clipboard.writeText(createdKey);
                            toast.success('API key copied to clipboard');
                          }}
                          className="cursor-pointer border-border text-accent-cyan hover:bg-muted h-8 flex-shrink-0"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Create new key */}
                  <div className="rounded-md border border-border bg-card/50 p-4 space-y-3">
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-2">
                        <Label htmlFor="apiKeyName" className="text-white">key name</Label>
                        <Input
                          id="apiKeyName"
                          type="text"
                          placeholder="e.g. CI/CD, monitoring script"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          className="border-border bg-background text-white"
                          disabled={creatingKey}
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        onClick={async () => {
                          setCreatingKey(true);
                          try {
                            const res = await fetch('/api/admin/keys/create', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ name: newKeyName || 'API Key' }),
                            });
                            const data = await res.json();
                            if (res.ok && data.success) {
                              setCreatedKey(data.key);
                              setNewKeyName('');
                              // Refresh list
                              const listRes = await fetch('/api/admin/keys');
                              const listData = await listRes.json();
                              if (listData.success) setApiKeys(listData.keys || []);
                              toast.success('API key created');
                            } else {
                              toast.error(data.error || 'Failed to create key');
                            }
                          } catch {
                            toast.error('Failed to create key');
                          }
                          setCreatingKey(false);
                        }}
                        disabled={creatingKey}
                        className="cursor-pointer bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 h-9"
                      >
                        {creatingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Plus className="h-3.5 w-3.5 mr-1" /> create key</>}
                      </Button>
                    </div>
                  </div>

                  {/* Existing keys list */}
                  {apiKeys.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-white">active keys</Label>
                      <div className="space-y-2">
                        {apiKeys.map((k) => (
                          <div key={k.id} className="flex items-center justify-between rounded-md border border-border bg-card/50 px-4 py-3">
                            <div className="space-y-0.5 min-w-0">
                              <p className="text-sm text-white truncate">{k.name}</p>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                <code className="font-mono">{k.keyPrefix}•••</code>
                                <span>created {new Date(k.createdAt).toLocaleDateString()}</span>
                                {k.lastUsedAt && (
                                  <span>last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                                )}
                              </div>
                            </div>
                            {confirmRevokeKeyId === k.id ? (
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <span className="text-xs text-red-400">revoke?</span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    setRevokingKeyId(k.id);
                                    try {
                                      const res = await fetch('/api/admin/keys/revoke', {
                                        method: 'DELETE',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ keyId: k.id }),
                                      });
                                      if (res.ok) {
                                        setApiKeys((prev) => prev.filter((key) => key.id !== k.id));
                                        toast.success('API key revoked');
                                      } else {
                                        toast.error('Failed to revoke key');
                                      }
                                    } catch {
                                      toast.error('Failed to revoke key');
                                    }
                                    setRevokingKeyId(null);
                                    setConfirmRevokeKeyId(null);
                                  }}
                                  disabled={revokingKeyId === k.id}
                                  className="cursor-pointer text-red-400 hover:text-red-300 hover:bg-red-950/30 h-7 px-2 text-xs"
                                >
                                  {revokingKeyId === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'yes'}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setConfirmRevokeKeyId(null)}
                                  className="cursor-pointer text-muted-foreground hover:text-white hover:bg-muted h-7 px-2 text-xs"
                                >
                                  no
                                </Button>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirmRevokeKeyId(k.id)}
                                className="cursor-pointer text-red-400 hover:text-red-300 hover:bg-red-950/30 h-8 flex-shrink-0"
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {apiKeys.length === 0 && !apiKeysLoading && (
                    <p className="text-xs text-muted-foreground">no API keys yet. create one to get started.</p>
                  )}

                  {/* Usage example */}
                  <div className="rounded-md border border-border bg-card/50 p-4 space-y-2">
                    <p className="text-xs text-muted-foreground font-medium">usage</p>
                    <code className="block text-[11px] bg-background rounded px-3 py-2 text-muted-foreground font-mono whitespace-pre-wrap">
                      {`curl "https://owlette.app/api/admin/machines?siteId=SITE_ID&api_key=owk_..."`}
                    </code>
                    <p className="text-[11px] text-muted-foreground">
                      or pass as header: <code className="font-mono">x-api-key: owk_...</code>
                    </p>
                  </div>
                </div>
              )}

              {/* ─── Danger Zone ─── */}
              {activeSection === 'danger' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-red-400">danger zone</h3>
                    <p className="text-xs text-muted-foreground mt-1">irreversible account actions</p>
                  </div>

                  <div className="space-y-3 rounded-md border border-red-800 bg-red-900/10 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Label className="text-red-400 font-semibold">delete account</Label>
                        <p className="text-sm text-muted-foreground">
                          permanently delete your account and all associated data. this action cannot be undone.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="w-full cursor-pointer bg-red-600 hover:bg-red-700 text-white"
                      disabled={loading || deleting}
                    >
                      delete account
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer — only show save/cancel for sections that need it */}
            {(activeSection === 'profile' || activeSection === 'preferences' || activeSection === 'security') && (
              <div className="border-t border-border px-6 py-3 flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  className="cursor-pointer border-border bg-secondary text-white hover:bg-muted"
                  disabled={loading}
                >
                  cancel
                </Button>
                <Button
                  onClick={handleSave}
                  className="cursor-pointer bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900"
                  disabled={loading}
                >
                  {loading ? 'saving...' : 'save changes'}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="border-border bg-secondary text-white">
            <DialogHeader>
              <DialogTitle className="text-red-400 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                delete account
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                this action is permanent and cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="rounded-md bg-red-900/20 border border-red-800 p-4">
                <p className="text-sm text-red-300 font-semibold mb-2">warning:</p>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>all your sites and machines will be permanently deleted</li>
                  <li>all deployments and logs will be removed</li>
                  <li>your account data cannot be recovered</li>
                  <li>you will be immediately signed out</li>
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="deletePassword" className="text-white">
                  enter your password to confirm
                </Label>
                <Input
                  id="deletePassword"
                  type="password"
                  placeholder="your password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="border-border bg-background text-white"
                  disabled={deleting}
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeletePassword('');
                }}
                className="cursor-pointer border-border bg-secondary text-white hover:bg-muted"
                disabled={deleting}
              >
                cancel
              </Button>
              <Button
                onClick={handleDeleteAccount}
                className="cursor-pointer bg-red-600 hover:bg-red-700 text-white"
                disabled={deleting || !deletePassword}
              >
                {deleting ? 'deleting...' : 'delete my account'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
