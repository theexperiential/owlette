'use client';

/**
 * /settings/alerts — self-serve alert-email preferences.
 *
 * This is the destination for the "manage alerts" link in every alert email
 * (added in wrapEmailLayout). It lets a recipient toggle individual alert
 * categories on/off instead of only fully unsubscribing. Each toggle saves
 * immediately (optimistic, reverting on failure). The same four+1 toggles live
 * in the account-settings dialog's "alerts" section — this page is the
 * deep-linkable, focused view of them.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth, type UserPreferences } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { ChevronLeft, Loader2 } from 'lucide-react';

type AlertKey =
  | 'healthAlerts'
  | 'processAlerts'
  | 'thresholdAlerts'
  | 'cortexAlerts'
  | 'displayAlerts';

const ALERT_TOGGLES: { key: AlertKey; label: string; desc: string }[] = [
  {
    key: 'healthAlerts',
    label: 'machine offline alerts',
    desc: 'receive email alerts when machines go offline',
  },
  {
    key: 'processAlerts',
    label: 'process crash alerts',
    desc: 'receive email alerts when monitored processes crash or fail to start',
  },
  {
    key: 'thresholdAlerts',
    label: 'threshold alerts',
    desc: 'receive email alerts when health metrics (CPU, GPU temp, disk, etc.) exceed configured thresholds',
  },
  {
    key: 'cortexAlerts',
    label: 'cortex escalation alerts',
    desc: "receive email alerts when automated diagnostics can't resolve an issue",
  },
  {
    key: 'displayAlerts',
    label: 'display events',
    desc: 'receive email alerts when monitors are removed, layouts drift, or display apply fails',
  },
];

function pickAlertPrefs(p: UserPreferences): Record<AlertKey, boolean> {
  return {
    healthAlerts: p.healthAlerts,
    processAlerts: p.processAlerts,
    thresholdAlerts: p.thresholdAlerts,
    cortexAlerts: p.cortexAlerts,
    displayAlerts: p.displayAlerts,
  };
}

export default function ManageAlertsPage() {
  const router = useRouter();
  const { user, userPreferences, updateUserPreferences, loading: authLoading } = useAuth();

  const [prefs, setPrefs] = useState<Record<AlertKey, boolean>>(() =>
    pickAlertPrefs(userPreferences),
  );
  const [savingKey, setSavingKey] = useState<AlertKey | null>(null);

  // Send unauthenticated visitors to login, preserving the return path so they
  // land back here after signing in (the email link is the common entry point).
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login?redirect=/settings/alerts');
    }
  }, [authLoading, user, router]);

  // Keep local toggles in sync with the source-of-truth preferences.
  // `userPreferences` only changes reference when preferences actually change.
  useEffect(() => {
    setPrefs(pickAlertPrefs(userPreferences));
  }, [userPreferences]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const toggle = async (key: AlertKey, value: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: value })); // optimistic
    setSavingKey(key);
    try {
      await updateUserPreferences({ [key]: value } as Partial<UserPreferences>, {
        silent: true,
      });
    } catch {
      // updateUserPreferences already surfaces a toast; revert the switch.
      setPrefs((prev) => ({ ...prev, [key]: !value }));
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <Link
          href="/dashboard"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          back to dashboard
        </Link>

        <div className="mb-6 flex items-center gap-3">
          <OwletteEyeIcon size={36} />
          <div>
            <h1 className="text-xl font-semibold text-foreground">manage alerts</h1>
            <p className="text-sm text-muted-foreground">
              choose which email alerts you receive. sent to{' '}
              <span className="font-medium text-foreground">{user.email}</span>.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {ALERT_TOGGLES.map(({ key, label, desc }) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4"
            >
              <div className="space-y-0.5 pr-4">
                <Label htmlFor={key} className="text-foreground">
                  {label}
                </Label>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
              <Switch
                id={key}
                checked={prefs[key]}
                onCheckedChange={(v) => toggle(key, v)}
                disabled={savingKey !== null}
              />
            </div>
          ))}
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          changes save automatically. need more control (CC recipients, threshold
          rules)? open account settings from the dashboard.
        </p>
      </div>
    </div>
  );
}
