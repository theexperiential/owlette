'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { validateSiteId, generateSiteIdFromName, generateRandomSiteId } from '@/lib/validators';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
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
  const [customIdOpen, setCustomIdOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>('idle');
  const [validationError, setValidationError] = useState<string>('');

  // Generate a random ID when the dialog opens
  useEffect(() => {
    if (open) {
      setNewSiteId(generateRandomSiteId());
      setNewSiteName('');
      setCustomIdOpen(false);
      setAvailabilityStatus('idle');
      setValidationError('');
    }
  }, [open]);

  // Check site ID availability with debouncing
  const checkAvailability = useCallback(async (siteId: string) => {
    if (!siteId || siteId.trim() === '') {
      setAvailabilityStatus('idle');
      setValidationError('');
      return;
    }

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

  const handleSiteIdChange = (value: string) => {
    const normalized = value.toLowerCase().replace(/\s+/g, '-');
    setNewSiteId(normalized);
  };

  const handleRegenerate = () => {
    setNewSiteId(generateRandomSiteId());
  };

  const handleCreateSite = async () => {
    if (!newSiteName.trim()) {
      toast.error('Please enter a site name');
      return;
    }

    if (!newSiteId.trim()) {
      toast.error('Site ID is missing');
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
      const browserTimezone = getBrowserTimezone();
      const createdSiteId = await onCreateSite(newSiteId, newSiteName, user.uid, browserTimezone);
      toast.success(`Site "${newSiteName}" created successfully!`);
      setNewSiteId('');
      setNewSiteName('');
      setAvailabilityStatus('idle');
      setValidationError('');
      onOpenChange(false);

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
          <DialogTitle className="text-white">create new site</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            sites organize your machines by location, purpose, or project. for example, create separate sites for different offices, studios, or installations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Site Name Input */}
          <div className="space-y-2">
            <Label htmlFor="site-name" className="text-white">site name</Label>
            <Input
              id="site-name"
              placeholder="e.g., NYC Office"
              value={newSiteName}
              onChange={(e) => setNewSiteName(e.target.value)}
              className="border-border bg-background text-white"
              autoFocus
            />
          </div>

          {/* Auto-generated Site ID preview */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>site ID:</span>
              <span className="font-mono text-accent-cyan">{newSiteId}</span>
              {getAvailabilityIcon()}
              <button
                type="button"
                onClick={handleRegenerate}
                className="text-muted-foreground hover:text-accent-cyan transition-colors cursor-pointer"
                title="generate new ID"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>

            {validationError && (
              <p className="text-xs text-red-400">{validationError}</p>
            )}

            {/* Expandable custom ID section */}
            <button
              type="button"
              onClick={() => setCustomIdOpen(!customIdOpen)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-accent-cyan transition-colors cursor-pointer"
            >
              {customIdOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              customize site ID
            </button>

            {customIdOpen && (
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
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border bg-secondary text-white hover:bg-muted cursor-pointer"
          >
            cancel
          </Button>
          <Button
            onClick={handleCreateSite}
            disabled={isCreating || availabilityStatus !== 'available'}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'creating...' : 'create site'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
