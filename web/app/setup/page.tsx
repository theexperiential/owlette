'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { collection, getDocs, Timestamp, getDoc, doc, setDoc } from 'firebase/firestore';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import Image from 'next/image';

interface Site {
  id: string;
  name: string;
  createdAt: Timestamp;
}

export default function SetupPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [creatingNewSite, setCreatingNewSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [callbackPort, setCallbackPort] = useState<string>('8765');
  const [isRedirecting, setIsRedirecting] = useState(false);

  // Get callback port from URL query params
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const port = params.get('callback_port');
      if (port) {
        setCallbackPort(port);
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
        // First, ensure user document exists
        const userDocRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);

        // If user document doesn't exist, create it
        if (!userDoc.exists()) {
          await setDoc(userDocRef, {
            email: user.email,
            role: 'user',
            sites: [],
            createdAt: Timestamp.now(),
          });

          // No sites available for new user
          setSites([]);
          setLoading(false);
          return;
        }

        const userData = userDoc.data();
        const userSites = userData.sites || [];
        const isAdmin = userData.role === 'admin';

        const fetchedSites: Site[] = [];

        if (isAdmin) {
          // Admins can list all sites via collection query
          const sitesRef = collection(db, 'sites');
          const sitesSnapshot = await getDocs(sitesRef);
          sitesSnapshot.forEach((doc) => {
            fetchedSites.push({
              id: doc.id,
              ...doc.data() as Omit<Site, 'id'>
            });
          });
        } else {
          // Non-admins: fetch each assigned site individually by ID.
          // Collection queries fail because Firestore rules use get() calls
          // that can't be evaluated for queries. Individual doc reads work fine.
          for (const siteId of userSites) {
            try {
              const siteDoc = await getDoc(doc(db, 'sites', siteId));
              if (siteDoc.exists()) {
                fetchedSites.push({
                  id: siteDoc.id,
                  ...siteDoc.data() as Omit<Site, 'id'>
                });
              }
            } catch (err) {
              console.warn(`Failed to fetch site ${siteId}:`, err);
            }
          }
        }

        setSites(fetchedSites);

        // Auto-select first site if only one exists
        if (fetchedSites.length === 1) {
          setSelectedSiteId(fetchedSites[0].id);
        }
      } catch (error: any) {
        console.error('Error fetching sites:', error);
        toast.error('Failed to fetch sites', {
          description: error.message || 'An error occurred while loading sites.',
        });
      } finally {
        setLoading(false);
      }
    }

    fetchSites();
  }, [user]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login?redirect=/setup');
    }
  }, [authLoading, user, router]);

  const handleCreateSite = async () => {
    if (!newSiteName.trim()) {
      toast.error('Site name is required');
      return;
    }

    if (!user || !db) {
      toast.error('You must be logged in to create a site');
      return;
    }

    setLoading(true);

    try {
      // Generate unique site ID: email@sitename format
      const emailPrefix = user.email?.split('@')[0] || user.uid;
      const sanitizedSiteName = newSiteName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      const siteId = `${emailPrefix}@${sanitizedSiteName}`;

      // Check if site already exists
      const siteDoc = await getDoc(doc(db, 'sites', siteId));
      if (siteDoc.exists()) {
        toast.error('Site already exists', {
          description: 'A site with this name already exists. Please choose a different name.',
        });
        setLoading(false);
        return;
      }

      // Create new site with the generated ID
      const newSiteRef = doc(db, 'sites', siteId);
      await setDoc(newSiteRef, {
        name: newSiteName.trim(),
        createdAt: Timestamp.now(),
        owner: user.uid,
        ownerEmail: user.email,
      });

      // Use the generated siteId
      const newSite: Site = {
        id: siteId,
        name: newSiteName.trim(),
        createdAt: Timestamp.now(),
      };

      setSites([...sites, newSite]);
      setSelectedSiteId(siteId);
      setCreatingNewSite(false);
      setNewSiteName('');

      toast.success('Site created successfully', {
        description: `Site "${newSiteName}" has been created.`,
      });
    } catch (error: any) {
      console.error('Error creating site:', error);
      toast.error('Failed to create site', {
        description: error.message || 'An error occurred while creating the site.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorizeAgent = async () => {
    if (!selectedSiteId) {
      toast.error('Please select a site');
      return;
    }

    if (!user) {
      toast.error('You must be logged in');
      return;
    }

    setIsRedirecting(true);

    try {
      // Generate secure token for agent
      const response = await fetch('/api/setup/generate-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          siteId: selectedSiteId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to generate authorization token');
      }

      const { token } = await response.json();

      // Redirect to localhost callback with site_id and token
      const callbackUrl = `http://localhost:${callbackPort}/callback?site_id=${encodeURIComponent(selectedSiteId)}&token=${encodeURIComponent(token)}`;

      // Redirect to callback URL
      window.location.href = callbackUrl;
    } catch (error: any) {
      console.error('Error authorizing agent:', error);
      toast.error('Authorization failed', {
        description: error.message || 'Failed to generate authorization token.',
      });
      setIsRedirecting(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
      </div>
    );
  }

  if (!user) {
    return null; // Will redirect to login
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-2xl bg-card/50 border-border">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <Image
            src="/owlette-icon.png"
            alt="Owlette"
            width={80}
            height={80}
            className="rounded-full"
            priority
          />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">Owlette Agent Setup</CardTitle>
            <CardDescription className="text-muted-foreground">
              Configure your Owlette Agent by selecting a site or creating a new one.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* User Info */}
          <div className="bg-muted/50 border border-border p-4 rounded-lg">
            <p className="text-sm text-muted-foreground">Logged in as</p>
            <p className="font-medium text-foreground">{user.email}</p>
          </div>

          {/* Site Selection */}
          {!creatingNewSite && (
            <div className="space-y-4">
              <Label htmlFor="site-select" className="text-foreground">Select Site</Label>
              {sites.length > 0 ? (
                <div className="flex gap-2">
                  <Select value={selectedSiteId} onValueChange={setSelectedSiteId}>
                    <SelectTrigger id="site-select" className="bg-muted/50 border-border text-foreground flex-1">
                      <SelectValue placeholder="Choose a site..." />
                    </SelectTrigger>
                    <SelectContent className="bg-muted border-border">
                      {sites.map((site) => (
                        <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                          {site.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    onClick={() => setCreatingNewSite(true)}
                    className="bg-muted/50 border-border text-foreground hover:bg-muted hover:text-foreground whitespace-nowrap"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create New Site
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    No sites available. Create a new site to get started.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setCreatingNewSite(true)}
                    className="w-full bg-muted/50 border-border text-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create New Site
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Create New Site */}
          {creatingNewSite && (
            <div className="space-y-4">
              <Label htmlFor="site-name" className="text-foreground">New Site Name</Label>
              <Input
                id="site-name"
                placeholder="e.g., My Studio, Client A, Production Floor"
                value={newSiteName}
                onChange={(e) => setNewSiteName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateSite();
                  }
                }}
                className="bg-muted/50 border-border text-foreground placeholder:text-muted-foreground"
              />

              <div className="flex gap-2">
                <Button
                  onClick={handleCreateSite}
                  disabled={!newSiteName.trim() || loading}
                  className="flex-1 bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Site'
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreatingNewSite(false);
                    setNewSiteName('');
                  }}
                  disabled={loading}
                  className="bg-muted/50 border-border text-foreground hover:bg-muted hover:text-foreground"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Authorize Agent Button */}
          {!creatingNewSite && selectedSiteId && (
            <div className="space-y-4 pt-4 border-t border-border">
              <div className="bg-accent-cyan/15 border border-accent-cyan/20 p-4 rounded-lg space-y-2">
                <p className="text-sm font-medium text-accent-cyan">
                  Selected Site
                </p>
                <p className="text-lg font-semibold text-foreground">
                  {sites.find((s) => s.id === selectedSiteId)?.name}
                </p>
                <p className="text-xs text-accent-cyan font-mono">
                  {selectedSiteId}
                </p>
              </div>

              <Button
                onClick={handleAuthorizeAgent}
                disabled={isRedirecting}
                className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                size="lg"
              >
                {isRedirecting ? (
                  <>
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                    Authorizing Agent...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-5 w-5 mr-2" />
                    Authorize Agent
                  </>
                )}
              </Button>

              <p className="text-xs text-muted-foreground text-center">
                This will configure your agent and redirect you back to the installer.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
