'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { validateSiteId, generateSiteIdFromName } from '@/lib/validators';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { CheckCircle2, XCircle, Loader2, Sparkles } from 'lucide-react';
import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';

interface CreateSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateSite: (siteId: string, siteName: string, userId: string, timezone?: string) => Promise<string>;
  onSiteCreated?: (siteId: string) => void;
}

type AvailabilityStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export function CreateSiteDialog({
  open,
  onOpenChange,
  onCreateSite,
  onSiteCreated,
}: CreateSiteDialogProps) {
  const { user } = useAuth();
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteId, setNewSiteId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>('idle');
  const [validationError, setValidationError] = useState<string>('');
  const [suggestedId, setSuggestedId] = useState<string>('');

  // Check site ID availability with debouncing
  const checkAvailability = useCallback(async (siteId: string) => {
    if (!siteId || siteId.trim() === '') {
      setAvailabilityStatus('idle');
      setValidationError('');
      return;
    }

    // Validate format first
    const validation = validateSiteId(siteId);
    if (!validation.isValid) {
      setAvailabilityStatus('invalid');
      setValidationError(validation.error || 'Invalid site ID');
      return;
    }

    setAvailabilityStatus('checking');
    setValidationError('');

    try {
      if (!db) {
        setAvailabilityStatus('invalid');
        setValidationError('Firebase not configured');
        return;
      }

      const siteRef = doc(db, 'sites', siteId);
      const siteSnap = await getDoc(siteRef);

      if (siteSnap.exists()) {
        setAvailabilityStatus('taken');
        setValidationError('This Site ID is already taken');
      } else {
        setAvailabilityStatus('available');
        setValidationError('');
      }
    } catch (error: any) {
      console.error('Error checking site availability:', error);
      if (error?.code === 'permission-denied') {
        // Fall back to allowing creation; server-side will enforce uniqueness.
        setAvailabilityStatus('available');
        setValidationError('');
        return;
      }
      setAvailabilityStatus('invalid');
      setValidationError('Failed to check availability');
    }
  }, []);

  // Debounce the availability check
  useEffect(() => {
    const timer = setTimeout(() => {
      if (newSiteId) {
        checkAvailability(newSiteId);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [newSiteId, checkAvailability]);

  // Generate suggested ID from site name
  useEffect(() => {
    if (newSiteName && !newSiteId) {
      const suggested = generateSiteIdFromName(newSiteName);
      setSuggestedId(suggested);
    } else {
      setSuggestedId('');
    }
  }, [newSiteName, newSiteId]);

  const handleSiteIdChange = (value: string) => {
    // Normalize to lowercase and replace spaces with hyphens
    const normalized = value.toLowerCase().replace(/\s+/g, '-');
    setNewSiteId(normalized);
  };

  const handleUseSuggestion = () => {
    setNewSiteId(suggestedId);
    setSuggestedId('');
  };

  const handleCreateSite = async () => {
    if (!newSiteId.trim() || !newSiteName.trim()) {
      toast.error('Please fill in both Site ID and Site Name');
      return;
    }

    if (!user) {
      toast.error('You must be logged in to create a site');
      return;
    }

    if (availabilityStatus !== 'available') {
      toast.error('Please choose an available Site ID');
      return;
    }

    setIsCreating(true);
    try {
      // Auto-detect browser timezone for new sites
      const browserTimezone = getBrowserTimezone();
      const createdSiteId = await onCreateSite(newSiteId, newSiteName, user.uid, browserTimezone);
      toast.success(`Site "${newSiteName}" created successfully!`);
      setNewSiteId('');
      setNewSiteName('');
      setAvailabilityStatus('idle');
      setValidationError('');
      setSuggestedId('');
      onOpenChange(false);

      // Notify parent to auto-switch to the newly created site
      if (onSiteCreated) {
        onSiteCreated(createdSiteId);
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to create site');
    } finally {
      setIsCreating(false);
    }
  };

  const getAvailabilityIcon = () => {
    switch (availabilityStatus) {
      case 'checking':
        return <Loader2 className="h-4 w-4 animate-spin text-accent-cyan" />;
      case 'available':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'taken':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'invalid':
        return <XCircle className="h-4 w-4 text-orange-500" />;
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white">
        <DialogHeader>
          <DialogTitle className="text-white">Create New Site</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Sites organize your machines by location, purpose, or project. For example, create separate sites for different offices, studios, or installations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Helpful examples */}
          <div className="rounded-lg bg-accent-cyan/10 border border-accent-cyan/30 p-3">
            <p className="text-xs text-accent-cyan mb-1 font-semibold">Example Site IDs:</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-accent-cyan">home-studio</span> •
              <span className="font-mono text-accent-cyan"> nyc-office</span> •
              <span className="font-mono text-accent-cyan"> production-floor</span> •
              <span className="font-mono text-accent-cyan"> client-site-a</span>
            </p>
          </div>

          {/* Site Name Input (first) */}
          <div className="space-y-2">
            <Label htmlFor="site-name" className="text-white">Site Name</Label>
            <Input
              id="site-name"
              placeholder="e.g., NYC Office"
              value={newSiteName}
              onChange={(e) => setNewSiteName(e.target.value)}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">Display name for the site</p>
          </div>

          {/* Site ID Input with availability checking */}
          <div className="space-y-2">
            <Label htmlFor="site-id" className="text-white">Site ID</Label>
            <div className="relative">
              <Input
                id="site-id"
                placeholder="e.g., nyc-office"
                value={newSiteId}
                onChange={(e) => handleSiteIdChange(e.target.value)}
                className={`border-border bg-background text-white pr-10 ${
                  availabilityStatus === 'taken' || availabilityStatus === 'invalid'
                    ? 'border-red-500/50 focus-visible:ring-red-500'
                    : availabilityStatus === 'available'
                    ? 'border-green-500/50 focus-visible:ring-green-500'
                    : ''
                }`}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {getAvailabilityIcon()}
              </div>
            </div>

            {/* Validation error or success message */}
            {validationError && (
              <p className="text-xs text-red-400">{validationError}</p>
            )}
            {availabilityStatus === 'available' && !validationError && (
              <p className="text-xs text-green-400">This Site ID is available!</p>
            )}
            {availabilityStatus === 'idle' && (
              <p className="text-xs text-muted-foreground">Unique identifier - lowercase letters, numbers, hyphens</p>
            )}

            {/* Auto-suggestion button */}
            {suggestedId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleUseSuggestion}
                className="mt-2 border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 cursor-pointer"
              >
                <Sparkles className="h-3 w-3 mr-1" />
                Use suggestion: <span className="font-mono ml-1">{suggestedId}</span>
              </Button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border bg-secondary text-white hover:bg-muted cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateSite}
            disabled={isCreating || availabilityStatus !== 'available'}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'Creating...' : 'Create Site'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
