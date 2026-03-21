'use client';

import { useState, useEffect, useCallback } from 'react';
import { Camera, Loader2, RefreshCw, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatRelativeTime } from '@/lib/timeUtils';

interface ScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  machineName: string;
  siteId: string;
  isOnline: boolean;
  onCaptureScreenshot: () => Promise<void>;
  /** Pre-loaded screenshot from machine document */
  lastScreenshot?: {
    url: string;
    timestamp: number;
    sizeKB: number;
  };
}

export function ScreenshotDialog({
  open,
  onOpenChange,
  machineId,
  machineName,
  siteId,
  isOnline,
  onCaptureScreenshot,
  lastScreenshot: initialScreenshot,
}: ScreenshotDialogProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState(initialScreenshot);

  // Listen for screenshot updates in real-time
  useEffect(() => {
    if (!open || !db || !siteId || !machineId) return;

    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(machineRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.lastScreenshot?.url) {
        setScreenshot((prev) => {
          // Only clear capturing state if this is a NEW screenshot
          if (!prev || data.lastScreenshot.timestamp !== prev.timestamp) {
            setIsCapturing(false);
            setError(null);
          }
          return data.lastScreenshot;
        });
      }
    });

    return () => unsubscribe();
  }, [open, siteId, machineId]);

  // Update from prop when dialog opens
  useEffect(() => {
    if (open && initialScreenshot) {
      setScreenshot(initialScreenshot);
    }
  }, [open, initialScreenshot]);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setError(null);

    try {
      await onCaptureScreenshot();

      // Set a timeout — if no screenshot arrives in 20s, show error
      const timeout = setTimeout(() => {
        setIsCapturing(false);
        setError('Screenshot timed out — the machine may be running headless or the GUI is not running.');
      }, 20000);

      // Clean up timeout when screenshot arrives (via the onSnapshot listener)
      return () => clearTimeout(timeout);
    } catch (err: any) {
      setIsCapturing(false);
      setError(err.message || 'Failed to send screenshot command');
    }
  }, [onCaptureScreenshot]);

  // Auto-capture on first open if no existing screenshot
  useEffect(() => {
    if (open && !screenshot && isOnline && !isCapturing) {
      handleCapture();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-4xl w-[90vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            screenshot — {machineName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Screenshot display */}
          <div className="relative bg-black/50 rounded-lg overflow-hidden min-h-[200px] flex items-center justify-center">
            {isCapturing && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p>capturing screenshot...</p>
              </div>
            )}

            {!isCapturing && error && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <AlertTriangle className="h-8 w-8 text-amber-400" />
                <p className="text-sm text-center max-w-md">{error}</p>
              </div>
            )}

            {!isCapturing && !error && !screenshot && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Camera className="h-8 w-8" />
                <p>no screenshot available</p>
              </div>
            )}

            {screenshot && !isCapturing && (
              <img
                src={screenshot.url}
                alt={`Screenshot of ${machineName}`}
                className="w-full h-auto max-h-[70vh] object-contain"
              />
            )}
          </div>

          {/* Footer info + refresh button */}
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {screenshot && (
                <>
                  captured {formatRelativeTime(screenshot.timestamp / 1000)} ({screenshot.sizeKB}KB)
                </>
              )}
              <span className="ml-2 text-muted-foreground/60">
                screenshots may contain sensitive content
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCapture}
              disabled={isCapturing || !isOnline}
              className="bg-secondary border-border hover:bg-accent"
            >
              {isCapturing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {isCapturing ? 'capturing...' : 'refresh'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
