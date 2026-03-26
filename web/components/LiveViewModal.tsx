'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, Loader2, Square, Play, Download, Maximize2, X as XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface LiveViewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  machineId: string;
  machineName: string;
  onStartLiveView: (machineId: string, interval: number, duration: number) => Promise<void>;
  onStopLiveView: (machineId: string) => Promise<void>;
}

export function LiveViewModal({
  open,
  onOpenChange,
  siteId,
  machineId,
  machineName,
  onStartLiveView,
  onStopLiveView,
}: LiveViewModalProps) {
  const [interval, setInterval_] = useState(10);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [liveViewActive, setLiveViewActive] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [screenshot, setScreenshot] = useState<{ url: string; timestamp: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for real-time machine doc updates (lastScreenshot + liveView state)
  useEffect(() => {
    if (!open || !db || !siteId || !machineId) return;

    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(machineRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      if (data.lastScreenshot?.url) {
        setScreenshot({
          url: data.lastScreenshot.url,
          timestamp: data.lastScreenshot.timestamp,
        });
      }

      const lv = data.liveView;
      if (lv) {
        setLiveViewActive(!!lv.active);
        setExpiresAt(lv.expiresAt ? lv.expiresAt * 1000 : null); // convert seconds to ms
        if (lv.interval) setInterval_(lv.interval);
      } else {
        setLiveViewActive(false);
        setExpiresAt(null);
      }
    });

    return () => unsubscribe();
  }, [open, siteId, machineId]);

  // Countdown timer
  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (!liveViewActive || !expiresAt) {
      setTimeRemaining('');
      return;
    }

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      if (remaining <= 0) {
        setTimeRemaining('expired');
        setLiveViewActive(false);
        if (countdownRef.current) clearInterval(countdownRef.current);
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      setTimeRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
    };

    updateCountdown();
    countdownRef.current = setInterval(updateCountdown, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [liveViewActive, expiresAt]);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setIsStarting(false);
      setIsStopping(false);
      setFullscreen(false);
    }
  }, [open]);

  const handleStart = useCallback(async () => {
    setIsStarting(true);
    try {
      await onStartLiveView(machineId, interval, 600);
    } catch (err) {
      console.error('Failed to start live view:', err);
    } finally {
      setIsStarting(false);
    }
  }, [machineId, interval, onStartLiveView]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      await onStopLiveView(machineId);
    } catch (err) {
      console.error('Failed to stop live view:', err);
    } finally {
      setIsStopping(false);
    }
  }, [machineId, onStopLiveView]);

  const handleDownload = useCallback(async () => {
    if (!screenshot?.url) return;
    try {
      const response = await fetch(screenshot.url);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${machineName}-liveview-${new Date(screenshot.timestamp).toISOString().replace(/[:.]/g, '-')}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      if (screenshot?.url) window.open(screenshot.url, '_blank');
    }
  }, [screenshot, machineName]);

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [fullscreen]);

  return (
    <>
      {/* Fullscreen overlay */}
      {fullscreen && screenshot && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center cursor-pointer"
          onClick={() => setFullscreen(false)}
        >
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-4 right-4 text-white hover:bg-white/20 z-10"
            onClick={(e) => { e.stopPropagation(); setFullscreen(false); }}
          >
            <XIcon className="h-6 w-6" />
          </Button>
          <img
            src={screenshot.url}
            alt={`Live view of ${machineName}`}
            className="max-w-[95vw] max-h-[95vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <Dialog open={open} onOpenChange={(v) => { if (fullscreen) { setFullscreen(false); return; } onOpenChange(v); }}>
        <DialogContent showCloseButton={false} className="bg-card border-border w-[calc(100vw-2rem)] sm:max-w-4xl max-w-none p-0 gap-0 h-[calc(100vh-4rem)] max-h-[700px]">
          <div className="flex flex-col h-full">
            {/* Header */}
            <DialogHeader className="px-4 py-2 border-b border-border flex-shrink-0">
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                live view — {machineName}
                {liveViewActive && timeRemaining && (
                  <span className="text-xs font-normal text-muted-foreground ml-2">
                    {timeRemaining} remaining
                  </span>
                )}
                {liveViewActive && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                    </span>
                    <span className="text-xs font-normal text-green-400">live</span>
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground ml-auto"
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="h-4 w-4" />
                </Button>
              </DialogTitle>
            </DialogHeader>

            {/* Screenshot display */}
            <div className="flex-1 relative bg-black/30 flex items-center justify-center overflow-hidden min-h-0">
              {!screenshot && !liveViewActive && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <Eye className="h-8 w-8" />
                  <p>start live view to see the remote desktop</p>
                </div>
              )}

              {!screenshot && liveViewActive && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin" />
                  <p>waiting for first screenshot...</p>
                </div>
              )}

              {screenshot && (
                <img
                  src={screenshot.url}
                  alt={`Live view of ${machineName}`}
                  className="absolute inset-0 w-full h-full object-contain cursor-pointer"
                  onClick={() => setFullscreen(true)}
                />
              )}
            </div>

            {/* Footer — controls */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border flex-shrink-0">
              <div className="flex items-center gap-3">
                {/* Interval selector */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">interval:</span>
                  <Select
                    value={String(interval)}
                    onValueChange={(v) => setInterval_(Number(v))}
                    disabled={liveViewActive}
                  >
                    <SelectTrigger className="h-7 w-[70px] text-xs bg-secondary border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5s</SelectItem>
                      <SelectItem value="10">10s</SelectItem>
                      <SelectItem value="20">20s</SelectItem>
                      <SelectItem value="30">30s</SelectItem>
                      <SelectItem value="60">60s</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {screenshot && (
                  <span className="text-xs text-muted-foreground">
                    last update: {new Date(screenshot.timestamp).toLocaleTimeString()}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {screenshot && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleDownload}
                      title="Download screenshot"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setFullscreen(true)}
                      title="Fullscreen"
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  </>
                )}

                {liveViewActive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStop}
                    disabled={isStopping}
                    className="bg-red-900/30 border-red-800 text-red-300 hover:bg-red-900/50 hover:text-red-200"
                  >
                    {isStopping ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4 mr-2" />
                    )}
                    {isStopping ? 'stopping...' : 'stop'}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStart}
                    disabled={isStarting}
                    className="bg-secondary border-border hover:bg-accent"
                  >
                    {isStarting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    {isStarting ? 'starting...' : 'start'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
