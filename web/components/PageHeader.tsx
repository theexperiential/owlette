'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ChevronRight, Settings, ChevronsUpDown, LogOut, Shield } from 'lucide-react';
import Image from 'next/image';
import { getUserInitials, getUserShortName, getUserFirstName } from '@/lib/userUtils';

interface Site {
  id: string;
  name: string;
}

interface PageHeaderProps {
  currentPage: 'Dashboard' | 'Deploy Software' | 'Distribute Projects' | 'Logs';
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

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-14 sm:h-16 max-w-screen-2xl items-center justify-between px-2 sm:px-4 gap-1 sm:gap-2 md:gap-4">
        <div className="flex items-center gap-1 sm:gap-2 md:gap-3 min-w-0 flex-1">
          {/* App Logo and Name */}
          <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
            <Image src="/owlette-icon.png" alt="Owlette" width={20} height={20} className="sm:w-8 sm:h-8" />
            <h1 className="text-base sm:text-xl font-bold text-white hidden md:block">Owlette</h1>
          </div>

          {/* Site Selector */}
          {sites.length > 0 && currentSiteId && onSiteChange && (
            <>
              <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground flex-shrink-0 hidden lg:block" />
              <div className="flex items-stretch border border-border bg-secondary rounded-md overflow-hidden flex-shrink-0 min-w-0">
                <Select value={currentSiteId} onValueChange={onSiteChange}>
                  <SelectTrigger className="w-[100px] sm:w-[120px] md:w-[160px] lg:w-[200px] border-0 bg-transparent text-white font-semibold cursor-pointer text-xs sm:text-xs md:text-sm focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none">
                    <SelectValue placeholder="Select site" />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-secondary">
                    {sites.map((site) => (
                      <SelectItem
                        key={site.id}
                        value={site.id}
                        className="text-white focus:bg-accent focus:text-white"
                      >
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {onManageSites && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onManageSites}
                    className="h-auto px-1 sm:px-1.5 md:px-2 text-muted-foreground hover:text-white hover:bg-muted cursor-pointer border-l border-border flex-shrink-0"
                  >
                    <Settings className="h-3 w-3 sm:h-3.5 sm:w-3.5 md:h-4 md:w-4" />
                  </Button>
                )}
              </div>
            </>
          )}

          {/* Breadcrumb separator */}
          <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground flex-shrink-0 hidden lg:block" />

          {/* Navigation Menu - Breadcrumb style */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-7 sm:h-8 md:h-10 px-1.5 sm:px-2 md:px-3 border-border bg-secondary text-xs sm:text-xs md:text-sm text-white hover:text-white hover:bg-secondary cursor-pointer flex-shrink-0">
                <span className="hidden md:inline">{currentPage}</span>
                <span className="md:hidden truncate max-w-[60px] sm:max-w-[80px]">{currentPage === 'Dashboard' ? 'Dash' : currentPage === 'Deploy Software' ? 'Deploy' : currentPage === 'Logs' ? 'Logs' : 'Proj'}</span>
                <ChevronsUpDown className="h-3 w-3 sm:h-3.5 sm:w-3.5 md:h-4 md:w-4 ml-0.5 sm:ml-1 flex-shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-secondary w-80">
              <DropdownMenuItem
                onClick={() => router.push('/dashboard')}
                className="text-white focus:bg-accent focus:text-white cursor-pointer py-4 px-4 flex flex-col items-start gap-1"
              >
                <span className="font-semibold text-base">Dashboard</span>
                <span className="text-sm text-muted-foreground font-normal">
                  Monitor machines, view status, and manage processes across your sites
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/deployments')}
                className="text-white focus:bg-accent focus:text-white cursor-pointer py-4 px-4 flex flex-col items-start gap-1"
              >
                <span className="font-semibold text-base">Deploy Software</span>
                <span className="text-sm text-muted-foreground font-normal">
                  Install software across multiple machines simultaneously
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/projects')}
                className="text-white focus:bg-accent focus:text-white cursor-pointer py-4 px-4 flex flex-col items-start gap-1"
              >
                <span className="font-semibold text-base">Distribute Projects</span>
                <span className="text-sm text-muted-foreground font-normal">
                  Share TouchDesigner projects and files to managed machines
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push('/logs')}
                className="text-white focus:bg-accent focus:text-white cursor-pointer py-4 px-4 flex flex-col items-start gap-1"
              >
                <span className="font-semibold text-base">Logs</span>
                <span className="text-sm text-muted-foreground font-normal">
                  Monitor process events and system activities
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 md:gap-4 flex-shrink-0">
          {/* Optional action button (e.g., Download, New Deployment) */}
          {actionButton}

          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-0.5 sm:gap-1 md:gap-2 h-auto py-1 sm:py-1.5 md:py-2 px-1 sm:px-2 md:px-3 hover:bg-secondary cursor-pointer">
                <Avatar className="h-6 w-6 sm:h-7 sm:w-7 md:h-8 md:w-8">
                  <AvatarFallback className="bg-accent-cyan text-gray-900 text-xs font-medium">
                    {user ? getUserInitials(user) : '?'}
                  </AvatarFallback>
                </Avatar>
                {user?.displayName && (
                  <>
                    {/* lg only: First name only (e.g., "Dylan") */}
                    <span className="text-xs sm:text-sm text-white hidden lg:inline xl:hidden">{getUserFirstName(user)}</span>
                    {/* xl only: First name + last initial (e.g., "Dylan R.") */}
                    <span className="text-xs sm:text-sm text-white hidden xl:inline 2xl:hidden">{getUserShortName(user)}</span>
                    {/* 2xl+: Full name (e.g., "Dylan Roscover") */}
                    <span className="text-xs sm:text-sm text-white hidden 2xl:inline">{user.displayName}</span>
                  </>
                )}
                <ChevronsUpDown className="h-3 w-3 text-muted-foreground hidden sm:block" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 border-border bg-secondary">
              <div className="px-2 py-3 text-sm">
                {user?.displayName && (
                  <p className="font-medium text-white mb-1">{user.displayName}</p>
                )}
                <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
              </div>
              <DropdownMenuSeparator className="bg-accent" />
              {isAdmin && (
                <DropdownMenuItem
                  onClick={() => router.push('/admin/installers')}
                  className="text-white focus:bg-accent focus:text-white cursor-pointer"
                >
                  <Shield className="mr-2 h-4 w-4" />
                  Admin Panel
                </DropdownMenuItem>
              )}
              {onAccountSettings && (
                <DropdownMenuItem
                  onClick={onAccountSettings}
                  className="text-white focus:bg-accent focus:text-white cursor-pointer"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Account Settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={signOut}
                className="text-white focus:bg-accent focus:text-white cursor-pointer"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
