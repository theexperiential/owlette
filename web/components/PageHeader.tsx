'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ChevronDown, Settings, LogOut, Shield, Check } from 'lucide-react';
import { getUserInitials, getUserShortName, getUserFirstName } from '@/lib/userUtils';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';

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
}

export function PageHeader({
  currentPage,
  sites = [],
  currentSiteId,
  onSiteChange,
  onManageSites,
  actionButton,
  onAccountSettings,
}: PageHeaderProps) {
  const router = useRouter();
  const { user, signOut, isAdmin } = useAuth();

  const currentSiteName = sites.find(s => s.id === currentSiteId)?.name ?? 'Select site';

  return (
    <>
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between px-2 md:px-3">
        {/* Left: Logo + Breadcrumb navigation */}
        <nav className="flex items-center gap-1.5 min-w-0">
          {/* App Logo */}
          <div className="flex items-center gap-1.5 flex-shrink-0 mr-1">
            <OwletteEyeIcon size={24} />
            <span className="text-base font-semibold text-foreground hidden md:block translate-y-[1px]">owlette</span>
          </div>

          {/* Breadcrumb: Site > Page */}
          {sites.length > 0 && currentSiteId && onSiteChange && (
            <>
              <span className="text-muted-foreground/60 text-lg select-none">/</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-secondary cursor-pointer truncate max-w-[140px] md:max-w-[200px]">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-secondary cursor-pointer">
                <span className="hidden sm:inline lowercase">{currentPage}</span>
                <span className="sm:hidden lowercase">{currentPage.toLowerCase() === 'dashboard' ? 'dashboard' : currentPage.toLowerCase() === 'deploy software' ? 'deploy' : currentPage.toLowerCase() === 'logs' ? 'logs' : currentPage.toLowerCase() === 'cortex' ? 'cortex' : 'projects'}</span>
                <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-secondary w-72">
              <DropdownMenuItem
                onClick={() => router.push('/dashboard')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">dashboard</span>
                <span className="text-xs text-muted-foreground font-normal">
                  monitor machines and manage processes
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/cortex')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">cortex</span>
                <span className="text-xs text-muted-foreground font-normal">
                  conversational fleet management
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/deployments')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">deploy software</span>
                <span className="text-xs text-muted-foreground font-normal">
                  install software across machines
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/projects')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">distribute projects</span>
                <span className="text-xs text-muted-foreground font-normal">
                  share projects and files to machines
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/logs')}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">logs</span>
                <span className="text-xs text-muted-foreground font-normal">
                  monitor events and system activities
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        {/* Right: Actions + User */}
        <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
          {actionButton}

          {/* User Menu */}
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
                onClick={signOut}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
              >
                <LogOut className="mr-2 h-4 w-4" />
                sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
    {/* Subtle top glow for readability over dot grid */}
    <div className="pointer-events-none absolute inset-x-0 top-14 h-48 z-0" style={{ background: 'linear-gradient(to bottom, oklch(0.20 0.03 250 / 0.7), transparent)' }} />
    </>
  );
}
