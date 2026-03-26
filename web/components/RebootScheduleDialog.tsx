'use client';

import { useState, useEffect, useMemo } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { ScheduleBlock } from '@/hooks/useFirestore';

const DAYS = [
  { key: 'mon', label: 'mon' },
  { key: 'tue', label: 'tue' },
  { key: 'wed', label: 'wed' },
  { key: 'thu', label: 'thu' },
  { key: 'fri', label: 'fri' },
  { key: 'sat', label: 'sat' },
  { key: 'sun', label: 'sun' },
] as const;

interface RebootScheduleDialogProps {
  siteId: string;
  machineId: string;
  machineName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSchedule?: {
    enabled: boolean;
    schedules: ScheduleBlock[];
  };
}

function getNextScheduledReboot(
  enabled: boolean,
  schedules: ScheduleBlock[],
  timezone?: string
): string {
  if (!enabled || schedules.length === 0) return 'none';

  const now = new Date();

  // Build a list of upcoming reboot times for the next 7 days
  const upcoming: Date[] = [];

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + dayOffset);
    const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][candidate.getDay()];

    for (const block of schedules) {
      if (!block.days.includes(dayName)) continue;

      for (const range of block.ranges) {
        const [startH, startM] = range.start.split(':').map(Number);
        const rebootTime = new Date(candidate);
        rebootTime.setHours(startH, startM, 0, 0);

        if (rebootTime > now) {
          upcoming.push(rebootTime);
        }
      }
    }
  }

  if (upcoming.length === 0) return 'none';

  upcoming.sort((a, b) => a.getTime() - b.getTime());
  const next = upcoming[0];

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const timeStr = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isToday = next.toDateString() === now.toDateString();
  const isTomorrow = next.toDateString() === new Date(now.getTime() + 86400000).toDateString();

  if (isToday) return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;
  return `${dayNames[next.getDay()]} at ${timeStr}`;
}

export default function RebootScheduleDialog({
  siteId,
  machineId,
  machineName,
  open,
  onOpenChange,
  currentSchedule,
}: RebootScheduleDialogProps) {
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState<string[]>(['sun']);
  const [startTime, setStartTime] = useState('03:00');
  const [stopTime, setStopTime] = useState('03:30');
  const [saving, setSaving] = useState(false);

  // Initialize from current schedule when dialog opens
  useEffect(() => {
    if (open) {
      if (currentSchedule) {
        setEnabled(currentSchedule.enabled);
        if (currentSchedule.schedules?.length > 0) {
          const block = currentSchedule.schedules[0];
          setDays(block.days || ['sun']);
          if (block.ranges?.length > 0) {
            setStartTime(block.ranges[0].start || '03:00');
            setStopTime(block.ranges[0].stop || '03:30');
          }
        }
      } else {
        setEnabled(false);
        setDays(['sun']);
        setStartTime('03:00');
        setStopTime('03:30');
      }
    }
  }, [open, currentSchedule]);

  const nextReboot = useMemo(
    () =>
      getNextScheduledReboot(enabled, [
        { days, ranges: [{ start: startTime, stop: stopTime }] },
      ]),
    [enabled, days, startTime, stopTime]
  );

  const toggleDay = (day: string) => {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const handleSave = async () => {
    if (!db) return;

    if (enabled && days.length === 0) {
      toast.error('Select at least one day');
      return;
    }

    setSaving(true);
    try {
      const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
      await updateDoc(machineRef, {
        rebootSchedule: {
          enabled,
          schedules: [
            {
              days,
              ranges: [{ start: startTime, stop: stopTime }],
            },
          ],
        },
      });

      toast.success('Reboot schedule saved');
      onOpenChange(false);
    } catch (error: any) {
      toast.error('Failed to save reboot schedule', {
        description: error.message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle>reboot schedule — {machineName}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            automatically reboot this machine on a recurring schedule.
            the machine must have been up for at least 30 minutes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Enable/disable toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="reboot-enabled" className="text-sm">
              enable scheduled reboots
            </Label>
            <Switch
              id="reboot-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          {enabled && (
            <>
              {/* Day selection */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">days</Label>
                <div className="flex gap-1.5">
                  {DAYS.map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => toggleDay(key)}
                      className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
                        days.includes(key)
                          ? 'bg-cyan-600 border-cyan-500 text-white'
                          : 'bg-secondary border-border text-muted-foreground hover:text-white hover:border-accent'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time range */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="reboot-start" className="text-sm text-muted-foreground">
                    window start
                  </Label>
                  <Input
                    id="reboot-start"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="bg-secondary border-border"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reboot-stop" className="text-sm text-muted-foreground">
                    window end
                  </Label>
                  <Input
                    id="reboot-stop"
                    type="time"
                    value={stopTime}
                    onChange={(e) => setStopTime(e.target.value)}
                    className="bg-secondary border-border"
                  />
                </div>
              </div>

              {/* Next reboot preview */}
              <div className="text-sm text-muted-foreground">
                next scheduled reboot:{' '}
                <span className="text-cyan-400">{nextReboot}</span>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="bg-secondary border-border hover:bg-accent"
          >
            cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-cyan-600 hover:bg-cyan-700"
          >
            {saving ? 'saving...' : 'save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
