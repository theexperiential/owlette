'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { getDoc, doc } from 'firebase/firestore';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, CheckCircle2, Monitor } from 'lucide-react';
import { toast } from '@/lib/toast';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';

interface Site {
  id: string;
  name: string;
}

export default function AddMachinePage() {
  const { user, loading: authLoading, isSuperadmin } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [pairPhrase, setPairPhrase] = useState('');
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [machineId, setMachineId] = useState<string | null>(null);
  /**
   * Whether the selection was auto-made (single-site convenience) rather than
   * chosen. `user` settles before `role`, so the first pass takes the narrower
   * membership branch; if that held one site it auto-selected, and the wider
   * superadmin list arriving after used to leave the stale pick in place —
   * authorizing against a site nobody chose. A deliberate choice is never withdrawn.
   */
  const autoSelectedRef = useRef(false);

  // Pairing phrase arrives as ?code= when the agent auto-opens the browser.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        setPairPhrase(code);
      }
    }
  }, []);

  useEffect(() => {
    async function fetchSites() {
      if (!user || !db) {
        setLoading(false);
        return;
      }

      try {
        const userDocRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);

        if (!userDoc.exists()) {
          setSites([]);
          setLoading(false);
          return;
        }

        const userData = userDoc.data();
        const siteIds = isSuperadmin ? [] : (userData.sites || []);
        const fetchedSites: Site[] = [];

        if (isSuperadmin) {
          // Superadmin sees every site, as on the setup page.
          const { collection, getDocs } = await import('firebase/firestore');
          const sitesRef = collection(db, 'sites');
          const sitesSnapshot = await getDocs(sitesRef);
          sitesSnapshot.forEach((doc) => {
            fetchedSites.push({ id: doc.id, ...doc.data() as Omit<Site, 'id'> });
          });
        } else {
          for (const siteId of siteIds) {
            try {
              const siteDoc = await getDoc(doc(db, 'sites', siteId));
              if (siteDoc.exists()) {
                fetchedSites.push({ id: siteDoc.id, ...siteDoc.data() as Omit<Site, 'id'> });
              }
            } catch {
              // Skip inaccessible sites.
            }
          }
        }

        setSites(fetchedSites);
        setSelectedSiteId((prev) => {
          // One choice — pick it, and record that we did.
          if (fetchedSites.length === 1) {
            autoSelectedRef.current = true;
            return fetchedSites[0].id;
          }
          // The list changed under an auto-selection: withdraw it.
          if (autoSelectedRef.current) {
            autoSelectedRef.current = false;
            return '';
          }
          // Keep a deliberate choice, unless the site is no longer offered.
          return prev && fetchedSites.some((s) => s.id === prev) ? prev : '';
        });
      } catch (error: unknown) {
        console.error('Error fetching sites:', error);
        toast.error('Failed to load sites');
      } finally {
        setLoading(false);
      }
    }

    fetchSites();
  }, [user, isSuperadmin]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login?redirect=/add');
    }
  }, [authLoading, user, router]);

  const handleAuthorize = async () => {
    if (!pairPhrase.trim()) {
      toast.error('Please enter a pairing phrase');
      return;
    }
    if (!selectedSiteId) {
      toast.error('Please select a site');
      return;
    }

    setIsAuthorizing(true);

    try {
      const response = await fetch('/api/agent/auth/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairPhrase: pairPhrase.trim().toLowerCase(),
          siteId: selectedSiteId,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Authorization failed');
      }

      const data = await response.json();
      setIsAuthorized(true);
      setMachineId(data.machineId);
      toast.success('Machine authorized!');
    } catch (error: unknown) {
      console.error('Error authorizing:', error);
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to authorize machine');
    } finally {
      setIsAuthorizing(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="relative flex items-center justify-center min-h-screen">
        <div className="absolute inset-0 dot-grid opacity-30" />
        <div className="absolute inset-0 blueprint-grid opacity-15" />
        <Loader2 className="relative z-10 h-8 w-8 animate-spin text-accent-cyan" />
      </div>
    );
  }

  if (!user) return null;

  if (isAuthorized) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-4">
        {/* Grid background */}
        <div className="absolute inset-0 dot-grid opacity-30" />
        <div className="absolute inset-0 blueprint-grid opacity-15" />
        <Card className="relative z-10 w-full max-w-md border-border bg-card text-center">
          <CardContent className="pt-10 pb-10 space-y-6">
            <div className="mx-auto w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-foreground">machine authorized</h2>
              <p className="text-muted-foreground">
                {machineId
                  ? `"${machineId}" will appear on your dashboard shortly.`
                  : 'The machine will appear on your dashboard shortly.'}
              </p>
            </div>
            <Button
              onClick={() => router.push('/dashboard')}
              className="text-gray-900 cursor-pointer"
            >
              go to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      <Card className="relative z-10 w-full max-w-lg border-border bg-card">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={80} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">add machine</CardTitle>
            <CardDescription className="text-muted-foreground">
              enter the pairing phrase shown on your machine
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Pairing Phrase Input */}
          <div className="space-y-2">
            <Label htmlFor="pair-phrase" className="text-foreground">pairing phrase</Label>
            <Input
              id="pair-phrase"
              placeholder="e.g., silver-compass-drift"
              value={pairPhrase}
              onChange={(e) => setPairPhrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && selectedSiteId) handleAuthorize();
              }}
              className="bg-muted/50 border-border text-foreground placeholder:text-muted-foreground font-mono text-lg"
              autoFocus
              autoComplete="off"
            />
          </div>

          {/* Site Selection */}
          <div className="space-y-2">
            <Label htmlFor="site-select" className="text-foreground">site</Label>
            {sites.length > 0 ? (
              <Select value={selectedSiteId} onValueChange={setSelectedSiteId}>
                <SelectTrigger id="site-select" className="bg-muted/50 border-border text-foreground">
                  <SelectValue placeholder="choose a site..." />
                </SelectTrigger>
                <SelectContent className="bg-muted border-border">
                  {sites.map((site) => (
                    <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                      {site.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                no sites available. create a site on the dashboard first.
              </p>
            )}
          </div>

          {/* Authorize Button */}
          {pairPhrase.trim() && selectedSiteId && (
            <Button
              onClick={handleAuthorize}
              disabled={isAuthorizing}
              className="w-full text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              size="lg"
            >
              {isAuthorizing ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  authorizing...
                </>
              ) : (
                <>
                  <Monitor className="h-5 w-5 mr-2" />
                  authorize machine
                </>
              )}
            </Button>
          )}

          {/* Logged in as */}
          <div className="text-xs text-muted-foreground text-center pt-2 border-t border-border">
            logged in as {user.email}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
