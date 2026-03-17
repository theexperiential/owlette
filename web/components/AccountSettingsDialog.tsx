'use client';

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EyeIcon, EyeOffIcon, AlertTriangle, Shield } from 'lucide-react';
import Link from 'next/link';

interface AccountSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccountSettingsDialog({ open, onOpenChange }: AccountSettingsDialogProps) {
  const { user, userPreferences, updateUserProfile, updatePassword, updateUserPreferences, deleteAccount } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [temperatureUnit, setTemperatureUnit] = useState<'C' | 'F'>('C');
  const [healthAlerts, setHealthAlerts] = useState(true);
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

  // Account deletion state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Parse existing display name and preferences when dialog opens
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      // Load display name
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

      // Load preferences
      setTemperatureUnit(userPreferences.temperatureUnit);
      setHealthAlerts(userPreferences.healthAlerts);
    } else {
      // Reset form when closing
      setFirstName('');
      setLastName('');
      setTemperatureUnit('C');
      setHealthAlerts(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
      setShowPasswordSection(false);
      setShowDeleteConfirm(false);
      setDeletePassword('');
    }
    onOpenChange(isOpen);
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
      // Always update profile if name fields are filled
      if (firstName || lastName) {
        await updateUserProfile(firstName, lastName);
      }

      // Update preferences if any changed
      const prefsChanged = temperatureUnit !== userPreferences.temperatureUnit
        || healthAlerts !== userPreferences.healthAlerts;
      if (prefsChanged) {
        await updateUserPreferences({ temperatureUnit, healthAlerts });
      }

      // Update password if password section is shown and fields are filled
      if (showPasswordSection && (currentPassword || newPassword || confirmPassword)) {
        if (!validatePassword()) {
          setLoading(false);
          return;
        }
        await updatePassword(currentPassword, newPassword);
        // Clear password fields after successful update
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
    if (!deletePassword) {
      return;
    }

    setDeleting(true);

    try {
      await deleteAccount(deletePassword);
      // Account deletion successful - user will be signed out automatically
      setShowDeleteConfirm(false);
      onOpenChange(false);
    } catch (error) {
      // Error already handled by AuthContext with toast
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-secondary text-white">
        <DialogHeader>
          <DialogTitle className="text-white">Account Settings</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Update your account information
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="settings-firstName" className="text-white">First Name</Label>
              <Input
                id="settings-firstName"
                type="text"
                placeholder="John"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="border-border bg-background text-white"
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-lastName" className="text-white">Last Name</Label>
              <Input
                id="settings-lastName"
                type="text"
                placeholder="Doe"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="border-border bg-background text-white"
                disabled={loading}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-white">Email</Label>
            <Input
              type="email"
              value={user?.email || ''}
              className="border-border bg-background text-muted-foreground"
              disabled
              readOnly
            />
            <p className="text-xs text-muted-foreground">Email cannot be changed</p>
          </div>

          {/* Temperature Unit */}
          <Separator className="bg-accent" />

          <div className="space-y-2">
            <Label htmlFor="temperatureUnit" className="text-white">Temperature Unit</Label>
            <Select
              value={temperatureUnit}
              onValueChange={(value: 'C' | 'F') => setTemperatureUnit(value)}
              disabled={loading}
            >
              <SelectTrigger
                id="temperatureUnit"
                className="border-border bg-background text-white hover:bg-secondary"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-secondary text-white">
                <SelectItem value="C" className="cursor-pointer hover:bg-muted">
                  Celsius (°C)
                </SelectItem>
                <SelectItem value="F" className="cursor-pointer hover:bg-muted">
                  Fahrenheit (°F)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Email Alerts */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="healthAlerts" className="text-white">Machine Offline Alerts</Label>
              <p className="text-xs text-muted-foreground">Receive email alerts when machines go offline</p>
            </div>
            <Switch
              id="healthAlerts"
              checked={healthAlerts}
              onCheckedChange={setHealthAlerts}
              disabled={loading}
            />
          </div>

          {/* Security Section */}
          <Separator className="bg-accent" />

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <Label className="text-white">Security</Label>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white">Two-Factor Authentication</p>
                <p className="text-xs text-muted-foreground">Add an extra layer of security to your account</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 cursor-pointer border-border text-accent-cyan hover:bg-muted hover:text-accent-cyan"
              >
                <Link
                  href="/setup-2fa"
                  onClick={() => onOpenChange(false)}
                >
                  Manage
                </Link>
              </Button>
            </div>
          </div>

          {/* Password Change Section */}
          <Separator className="bg-accent" />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-white">Change Password</Label>
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
                {showPasswordSection ? 'Cancel' : 'Update Password'}
              </Button>
            </div>

            {showPasswordSection && (
              <div className="space-y-3 rounded-md border border-border bg-background/50 p-4">
                <div className="space-y-2">
                  <Label htmlFor="currentPassword" className="text-white">Current Password</Label>
                  <div className="relative">
                    <Input
                      id="currentPassword"
                      type={showCurrentPassword ? 'text' : 'password'}
                      placeholder="Enter current password"
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
                      {showCurrentPassword ? (
                        <EyeOffIcon className="h-4 w-4" />
                      ) : (
                        <EyeIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="newPassword" className="text-white">New Password</Label>
                  <div className="relative">
                    <Input
                      id="newPassword"
                      type={showNewPassword ? 'text' : 'password'}
                      placeholder="Enter new password"
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
                      {showNewPassword ? (
                        <EyeOffIcon className="h-4 w-4" />
                      ) : (
                        <EyeIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">Must be at least 6 characters</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-white">Confirm New Password</Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      placeholder="Confirm new password"
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
                      {showConfirmPassword ? (
                        <EyeOffIcon className="h-4 w-4" />
                      ) : (
                        <EyeIcon className="h-4 w-4" />
                      )}
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

          {/* Danger Zone */}
          <Separator className="bg-accent" />

          <div className="space-y-3 rounded-md border border-red-800 bg-red-900/10 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Label className="text-red-400 font-semibold">Danger Zone</Label>
                <p className="text-sm text-muted-foreground">
                  Permanently delete your account and all associated data. This action cannot be undone.
                </p>
              </div>
            </div>
            <Button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="w-full cursor-pointer bg-red-600 hover:bg-red-700 text-white"
              disabled={loading || deleting}
            >
              Delete Account
            </Button>
          </div>
        </div>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="border-border bg-secondary text-white">
            <DialogHeader>
              <DialogTitle className="text-red-400 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Delete Account
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                This action is permanent and cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="rounded-md bg-red-900/20 border border-red-800 p-4">
                <p className="text-sm text-red-300 font-semibold mb-2">Warning:</p>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>All your sites and machines will be permanently deleted</li>
                  <li>All deployments and logs will be removed</li>
                  <li>Your account data cannot be recovered</li>
                  <li>You will be immediately signed out</li>
                </ul>
              </div>

              <div className="space-y-2">
                <Label htmlFor="deletePassword" className="text-white">
                  Enter your password to confirm
                </Label>
                <Input
                  id="deletePassword"
                  type="password"
                  placeholder="Your password"
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
                Cancel
              </Button>
              <Button
                onClick={handleDeleteAccount}
                className="cursor-pointer bg-red-600 hover:bg-red-700 text-white"
                disabled={deleting || !deletePassword}
              >
                {deleting ? 'Deleting...' : 'Delete My Account'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="cursor-pointer border-border bg-secondary text-white hover:bg-muted"
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="cursor-pointer bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900"
            disabled={loading}
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
