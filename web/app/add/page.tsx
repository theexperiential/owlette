'use client';

import { useState, useEffect } from 'react';
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
import { toast } from 'sonner';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';

interface Site {
  id: string;
  name: string;
}

export default function AddMachinePage() {
  const { user, loading: authLoading, userSites, isAdmin } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [pairPhrase, setPairPhrase] = useState('');
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [machineId, setMachineId] = useState<string | null>(null);

  // Get pairing phrase from URL query params (from agent browser auto-open)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        setPairPhrase(code);
      }
    }
  }, []);

  // Fetch user's sites
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
        const siteIds = isAdmin ? [] : (userData.sites || []);
        const fetchedSites: Site[] = [];

        if (isAdmin) {
          // Admin: fetch all sites via collection (same as setup page)
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
              // Skip inaccessible sites
            }
          }
        }

        setSites(fetchedSites);
        if (fetchedSites.length === 1) {
          setSelectedSiteId(fetchedSites[0].id);
        }
      } catch (error: any) {
        console.error('Error fetching sites:', error);
        toast.error('Failed to load sites');
      } finally {
        setLoading(false);
      }
    }

    fetchSites();
  }, [user, isAdmin]);

  // Redirect to login if not authenticated
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
    } catch (error: any) {
      console.error('Error authorizing:', error);
      toast.error(error.message || 'Failed to authorize machine');
    } finally {
      setIsAuthorizing(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
      </div>
    );
  }

  if (!user) return null;

  // Success state
  if (isAuthorized) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md bg-card/50 border-border text-center">
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
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              go to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-lg bg-card/50 border-border">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={48} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-xl font-bold text-foreground">add machine</CardTitle>
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
                No sites available. Create a site on the dashboard first.
              </p>
            )}
          </div>

          {/* Authorize Button */}
          {pairPhrase.trim() && selectedSiteId && (
            <Button
              onClick={handleAuthorize}
              disabled={isAuthorizing}
              className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
