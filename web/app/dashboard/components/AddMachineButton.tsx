'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Loader2, CheckCircle2, Copy, Monitor, Terminal, Download, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';

interface AddMachineButtonProps {
  currentSiteId: string;
  currentSiteName?: string;
}

export function AddMachineButton({ currentSiteId, currentSiteName }: AddMachineButtonProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'enter' | 'generate'>('enter');
  const { version, downloadUrl, isLoading: isLoadingVersion } = useInstallerVersion();

  // Enter Code tab state
  const [enterPhrase, setEnterPhrase] = useState('');
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [enterSuccess, setEnterSuccess] = useState(false);

  // Generate Code tab state
  const [generatedPhrase, setGeneratedPhrase] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateSuccess, setGenerateSuccess] = useState(false);

  const resetState = () => {
    setEnterPhrase('');
    setIsAuthorizing(false);
    setEnterSuccess(false);
    setGeneratedPhrase('');
    setIsGenerating(false);
    setGenerateSuccess(false);
    setTab('enter');
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) resetState();
  };

  // Enter Code: authorize an existing phrase
  const handleAuthorize = async () => {
    if (!enterPhrase.trim() || !currentSiteId) return;

    setIsAuthorizing(true);
    try {
      const response = await fetch('/api/agent/auth/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairPhrase: enterPhrase.trim().toLowerCase(),
          siteId: currentSiteId,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Authorization failed');
      }

      setEnterSuccess(true);
      toast.success('Machine authorized! It will appear on your dashboard shortly.');
    } catch (error: any) {
      toast.error(error.message || 'Failed to authorize machine');
    } finally {
      setIsAuthorizing(false);
    }
  };

  // Generate Code: create a pre-authorized phrase for /ADD= bulk deploy
  const handleGenerate = async () => {
    if (!currentSiteId) return;

    setIsGenerating(true);
    try {
      // Step 1: Request a device code from the server
      const codeResponse = await fetch('/api/agent/auth/device-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!codeResponse.ok) {
        throw new Error('Failed to generate pairing phrase');
      }

      const codeData = await codeResponse.json();
      const phrase = codeData.pairPhrase;

      // Step 2: Immediately authorize it for the current site
      const authResponse = await fetch('/api/agent/auth/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairPhrase: phrase,
          siteId: currentSiteId,
        }),
      });

      if (!authResponse.ok) {
        const data = await authResponse.json();
        throw new Error(data.error || 'Failed to authorize phrase');
      }

      setGeneratedPhrase(phrase);
      setGenerateSuccess(true);
    } catch (error: any) {
      toast.error(error.message || 'Failed to generate code');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(true)}
              className="text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer group"
            >
              <Plus className="h-4 w-4" />
              <span className="max-w-0 overflow-hidden group-hover:max-w-32 transition-all duration-200 ease-in-out whitespace-nowrap">
                &nbsp;add machine
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>add a new machine to this site</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">add machine</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {currentSiteName ? `adding to "${currentSiteName}"` : 'add a machine to the current site'}
            </DialogDescription>
          </DialogHeader>

          {/* Tab switcher */}
          <div className="relative grid grid-cols-2 rounded-lg bg-muted p-1">
            {/* Sliding indicator */}
            <div
              className="absolute rounded-md bg-background transition-transform duration-200 ease-in-out pointer-events-none"
              style={{
                top: '4px', bottom: '4px', left: '4px',
                width: 'calc(50% - 4px)',
                transform: tab === 'generate' ? 'translateX(100%)' : 'translateX(0)',
              }}
            />
            <button
              onClick={() => setTab('enter')}
              className={`relative z-10 rounded-md px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                tab === 'enter' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              enter code
            </button>
            <button
              onClick={() => setTab('generate')}
              className={`relative z-10 rounded-md px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                tab === 'generate' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              generate code
            </button>
          </div>

          {/* Tab 1: Enter Code (for machines already showing a phrase) */}
          {tab === 'enter' && (
            <div className="space-y-5 mt-5">
              {enterSuccess ? (
                <div className="text-center space-y-4 py-4">
                  <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  </div>
                  <p className="text-foreground font-medium">machine authorized</p>
                  <p className="text-sm text-muted-foreground">
                    it will appear on your dashboard shortly.
                  </p>
                </div>
              ) : (
                <>
                  {/* Install instructions */}
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground leading-snug">
                      1) install owlette on the target machine
                    </p>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <TooltipProvider disableHoverableContent>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isLoadingVersion || !downloadUrl}
                              onClick={() => downloadUrl && window.open(downloadUrl, '_blank')}
                              className="text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer p-1.5"
                            >
                              {isLoadingVersion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>{isLoadingVersion ? 'loading...' : `download v${version}`}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <TooltipProvider disableHoverableContent>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isLoadingVersion || !downloadUrl}
                              onClick={() => {
                                if (downloadUrl) {
                                  navigator.clipboard.writeText(downloadUrl);
                                  toast.success('download link copied');
                                }
                              }}
                              className="text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer p-1.5"
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>copy download link</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      2) enter the 3-word phrase shown on the machine
                    </p>
                    <Input
                      placeholder="e.g., silver-compass-drift"
                      value={enterPhrase}
                      onChange={(e) => setEnterPhrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAuthorize();
                      }}
                      className="bg-muted/50 border-border text-foreground font-mono"
                      autoFocus
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    onClick={handleAuthorize}
                    disabled={!enterPhrase.trim() || isAuthorizing}
                    className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAuthorizing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        authorizing...
                      </>
                    ) : (
                      <>
                        <Monitor className="h-4 w-4 mr-2" />
                        authorize
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Tab 2: Generate Code (for /ADD= bulk deploy) */}
          {tab === 'generate' && (
            <div className="space-y-4 mt-4">
              {generateSuccess && generatedPhrase ? (
                <div className="space-y-4">
                  <div className="text-center space-y-2">
                    <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                    </div>
                    <p className="text-foreground font-medium">code ready</p>
                  </div>

                  {/* Phrase with copy */}
                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">pairing phrase</Label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 font-mono text-foreground">
                        {generatedPhrase}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(generatedPhrase, 'Phrase')}
                        className="border-border text-foreground hover:bg-secondary cursor-pointer shrink-0"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Command with copy */}
                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">silent install command</Label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                        Owlette-Installer-v{version ?? '...'}.exe /ADD={generatedPhrase} /SILENT
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(
                          `Owlette-Installer-v${version}.exe /ADD=${generatedPhrase} /SILENT`,
                          'Command'
                        )}
                        className="border-border text-foreground hover:bg-secondary cursor-pointer shrink-0"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      expires in 10 minutes
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setGenerateSuccess(false); setGeneratedPhrase(''); handleGenerate(); }}
                      className="text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer h-7 px-2 text-xs"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      regenerate
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-muted/30 border border-border rounded-lg p-4 space-y-2">
                    <div className="flex items-center gap-2 text-foreground font-medium text-sm">
                      <Terminal className="h-4 w-4 text-accent-cyan" />
                      bulk deployment
                    </div>
                    <p className="text-xs text-muted-foreground">
                      generate a pre-authorized pairing phrase. use it with the installer&apos;s
                      <code className="mx-1 px-1 py-0.5 bg-muted rounded text-foreground">/ADD=</code>
                      flag to silently add machines to this site.
                    </p>
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        generating...
                      </>
                    ) : (
                      'generate code'
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
