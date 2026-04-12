'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowRight, ChevronDown, Settings, LogOut, Shield, Check, LayoutDashboard, Brain, Rocket, FolderSync, ScrollText, CircleHelp, Bug, BookOpen } from 'lucide-react';
import { getUserInitials, getUserShortName } from '@/lib/userUtils';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { ReportBugDialog } from '@/components/ReportBugDialog';

interface Site {
  id: string;
  name: string;
}

interface PageHeaderProps {
  currentPage: 'Dashboard' | 'Deploy Software' | 'Distribute Projects' | 'Logs' | 'Cortex' | 'dashboard' | 'deploy software' | 'distribute projects' | 'logs' | 'cortex';
  sites?: Site[];
  currentSiteId?: string;
  onSiteChange?: (siteId: string) => void;
  onManageSites?: () => void;
  actionButton?: React.ReactNode;
  onAccountSettings?: () => void;
  disableNav?: boolean;
}

export function PageHeader({
  currentPage,
  sites = [],
  currentSiteId,
  onSiteChange,
  onManageSites,
  actionButton,
  onAccountSettings,
  disableNav,
}: PageHeaderProps) {
  const router = useRouter();
  const { user, signOut, isAdmin } = useAuth();
  const [reportBugOpen, setReportBugOpen] = useState(false);
  const [feedbackLabel, setFeedbackLabel] = useState('report a bug');
  const [feedbackFading, setFeedbackFading] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const feedbackIndex = useRef(0);

  const FEEDBACK_LABELS = [
    'report a bug',
    'share feedback',
    'tell us how terrible we\'re doing',
    'yell into the void',
    'file a complaint',
    'it\'s not you, it\'s us',
    'we can take it',
  ];

  useEffect(() => {
    if (!helpMenuOpen) return;
    feedbackIndex.current = Math.floor(Math.random() * FEEDBACK_LABELS.length);
    setFeedbackLabel(FEEDBACK_LABELS[feedbackIndex.current]);

    const interval = setInterval(() => {
      setFeedbackFading(true);
      setTimeout(() => {
        feedbackIndex.current = (feedbackIndex.current + 1) % FEEDBACK_LABELS.length;
        setFeedbackLabel(FEEDBACK_LABELS[feedbackIndex.current]);
        setFeedbackFading(false);
      }, 300);
    }, 4000);

    return () => clearInterval(interval);
  }, [helpMenuOpen]);

  const currentSiteName = sites.find(s => s.id === currentSiteId)?.name ?? 'Select site';

  return (
    <>
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between px-2 md:px-3">
        {/* Left: Logo + Breadcrumb navigation */}
        <nav className="flex items-center gap-1.5 min-w-0">
          {/* App Logo */}
          <div className="flex items-center gap-1.5 flex-shrink-0 mr-1">
            <OwletteEyeIcon size={24} className="translate-y-[1px]" />
            <span className="text-base font-semibold text-foreground hidden md:block translate-y-[1px]">owlette</span>
          </div>

          {/* Breadcrumb: Site > Page */}
          {sites.length > 0 && currentSiteId && onSiteChange && (
            <>
              <span className="text-muted-foreground/60 text-lg select-none">/</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-secondary cursor-pointer truncate max-w-[200px] md:max-w-[320px]">
                    <span className="truncate">{currentSiteName}</span>
                    <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="border-border bg-secondary w-64">
                  {sites.map((site) => (
                    <DropdownMenuItem
                      key={site.id}
                      onClick={() => onSiteChange(site.id)}
                      className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer flex items-center justify-between"
                    >
                      <span className="truncate">{site.name}</span>
                      {site.id === currentSiteId && <Check className="h-4 w-4 text-accent-cyan flex-shrink-0" />}
                    </DropdownMenuItem>
                  ))}
                  {onManageSites && (
                    <>
                      <DropdownMenuSeparator className="bg-border" />
                      <DropdownMenuItem
                        onClick={onManageSites}
                        className="text-muted-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                      >
                        <Settings className="mr-2 h-4 w-4" />
                        manage sites
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          <span className="text-muted-foreground/60 text-lg select-none">/</span>

          {/* Page Selector */}
          {disableNav ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground px-1.5 py-1">
              {(() => {
                const pageIcons: Record<string, React.ElementType> = { dashboard: LayoutDashboard, cortex: Brain, 'deploy software': Rocket, 'distribute projects': FolderSync, logs: ScrollText };
                const PageIcon = pageIcons[currentPage.toLowerCase()];
                return PageIcon ? <PageIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground translate-y-[0.5px]" /> : null;
              })()}
              <span className="lowercase">{currentPage}</span>
            </span>
          ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-secondary cursor-pointer">
                {(() => {
                  const pageIcons: Record<string, React.ElementType> = { dashboard: LayoutDashboard, cortex: Brain, 'deploy software': Rocket, 'distribute projects': FolderSync, logs: ScrollText };
                  const PageIcon = pageIcons[currentPage.toLowerCase()];
                  return PageIcon ? <PageIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground translate-y-[0.5px]" /> : null;
                })()}
                <span className="hidden sm:inline lowercase">{currentPage}</span>
                <span className="sm:hidden lowercase">{currentPage.toLowerCase() === 'dashboard' ? 'dashboard' : currentPage.toLowerCase() === 'deploy software' ? 'deploy' : currentPage.toLowerCase() === 'logs' ? 'logs' : currentPage.toLowerCase() === 'cortex' ? 'cortex' : 'projects'}</span>
                <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-secondary w-72">
              <DropdownMenuItem
                onClick={() => router.push('/dashboard')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex items-start gap-3"
              >
                <LayoutDashboard className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">dashboard</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    monitor machines and manage processes
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/cortex')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex items-start gap-3"
              >
                <Brain className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">cortex</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    conversational fleet management
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/deployments')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex items-start gap-3"
              >
                <Rocket className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">deploy software</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    install software across machines
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/projects')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex items-start gap-3"
              >
                <FolderSync className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">distribute projects</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    share projects and files to machines
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/logs')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex items-start gap-3"
              >
                <ScrollText className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">logs</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    monitor events and system activities
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          )}
        </nav>

        {/* Right: Actions + User */}
        <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
          {actionButton}

          {/* Help Menu */}
          {!disableNav && (
            <DropdownMenu onOpenChange={setHelpMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-secondary transition-colors cursor-pointer">
                  <CircleHelp className="h-4 w-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 border-border bg-secondary">
                <DropdownMenuItem asChild className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer">
                  <a href="https://theexperiential.github.io/owlette/" target="_blank" rel="noopener noreferrer">
                    <BookOpen className="mr-2 h-4 w-4" />
                    docs
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setReportBugOpen(true)}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Bug className="mr-2 h-4 w-4 flex-shrink-0" />
                  <span className="transition-opacity duration-300" style={{ opacity: feedbackFading ? 0 : 1 }}>
                    {feedbackLabel}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {disableNav ? (
            /* Demo mode: show sign in + get started instead of user menu */
            <div className="flex items-center gap-2">
              <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors px-2 py-1">
                sign in
              </Link>
              <Link href="/register" className="inline-flex items-center gap-1.5 text-sm bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-4 py-1.5 rounded-md transition-colors group">
                get started
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>
          ) : (
          /* User Menu */
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-secondary transition-colors cursor-pointer">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-accent-cyan text-gray-900 text-xs font-medium">
                    {user ? getUserInitials(user) : '?'}
                  </AvatarFallback>
                </Avatar>
                {user?.displayName && (
                  <span className="text-sm text-foreground hidden lg:block">{getUserShortName(user)}</span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 border-border bg-secondary">
              <div className="px-3 py-2.5">
                {user?.displayName && (
                  <p className="text-sm font-medium text-foreground">{user.displayName}</p>
                )}
                <p className="text-xs text-muted-foreground truncate mt-0.5">{user?.email}</p>
              </div>
              <DropdownMenuSeparator className="bg-border" />
              {isAdmin && (
                <DropdownMenuItem
                  onClick={() => router.push('/admin/installers')}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Shield className="mr-2 h-4 w-4" />
                  admin panel
                </DropdownMenuItem>
              )}
              {onAccountSettings && (
                <DropdownMenuItem
                  onClick={onAccountSettings}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  account settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  router.push('/');
                }}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
              >
                <LogOut className="mr-2 h-4 w-4" />
                sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      </div>
    </header>
    {/* Subtle top glow for readability over dot grid */}
    <div className="pointer-events-none absolute inset-x-0 top-14 h-48 z-0" style={{ background: 'linear-gradient(to bottom, oklch(0.20 0.03 250 / 0.7), transparent)' }} />
    <ReportBugDialog open={reportBugOpen} onOpenChange={setReportBugOpen} />
    </>
  );
}
