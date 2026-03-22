'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import RequireAdmin from '@/components/RequireAdmin';
import { Shield, Users, Package, ArrowLeft, Menu, X, Settings, Mail, KeyRound, Webhook, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Admin Layout
 *
 * Wraps all admin pages with:
 * - Admin permission check (RequireAdmin component)
 * - Navigation sidebar for admin sections
 * - Consistent styling
 * - Mobile responsive with hamburger menu
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    {
      name: 'Installers',
      href: '/admin/installers',
      icon: Package,
      description: 'Manage agent installer versions',
    },
    {
      name: 'Template Library',
      href: '/admin/presets',
      icon: Settings,
      description: 'Manage software catalog',
    },
    {
      name: 'User Management',
      href: '/admin/users',
      icon: Users,
      description: 'Manage user roles and permissions',
    },
    {
      name: 'Agent Tokens',
      href: '/admin/tokens',
      icon: KeyRound,
      description: 'View and revoke agent tokens',
    },
    {
      name: 'Schedules',
      href: '/admin/schedules',
      icon: Clock,
      description: 'Manage schedule presets',
    },
    {
      name: 'Webhooks',
      href: '/admin/webhooks',
      icon: Webhook,
      description: 'Configure webhook notifications',
    },
    {
      name: 'Email Test',
      href: '/admin/test-email',
      icon: Mail,
      description: 'Test email notifications',
    },
  ];

  // Determine back button destination based on current page
  const getBackHref = () => {
    if (pathname === '/admin/installers' || pathname === '/admin/presets') {
      return '/deployments';
    }
    return '/dashboard';
  };

  const getBackLabel = () => {
    if (pathname === '/admin/installers' || pathname === '/admin/presets') {
      return 'Back to Deployments';
    }
    return 'Back to Dashboard';
  };

  return (
    <RequireAdmin>
      <TooltipProvider delayDuration={100}>
        <div className="flex min-h-screen">
        {/* Mobile Menu Button */}
        {!mobileMenuOpen && (
          <div className="lg:hidden fixed top-4 left-4 z-50">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMobileMenuOpen(true)}
              className="border-border bg-muted/95 backdrop-blur-sm text-foreground hover:bg-muted cursor-pointer shadow-lg"
            >
              <Menu className="h-5 w-5 stroke-[2.5]" />
            </Button>
          </div>
        )}

        {/* Mobile Overlay */}
        {mobileMenuOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}

        {/* Sidebar Navigation */}
        <aside className={`
          w-64 lg:w-20 xl:w-64 bg-card border-r border-border flex flex-col
          fixed lg:static inset-y-0 left-0 z-40
          transform transition-all duration-200 ease-in-out
          ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}>
          {/* Header */}
          <div className="p-6 lg:p-3 xl:p-6 border-b border-border">
            {/* Mobile Header */}
            <div className="lg:hidden mb-4">
              <div className="flex items-center justify-between mb-2">
                <h1 className="text-xl font-bold text-foreground">Admin Panel</h1>
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 hover:bg-muted rounded-lg transition-colors cursor-pointer"
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground">System Management</p>
            </div>

            {/* Desktop/Tablet Header */}
            <div className="hidden lg:flex items-center gap-3 mb-4 lg:justify-center xl:justify-start">
              <div className="p-2 bg-accent-cyan rounded-lg flex-shrink-0">
                <Shield className="h-6 w-6 text-foreground" />
              </div>
              <div className="hidden xl:block">
                <h1 className="text-xl font-bold text-foreground">Admin Panel</h1>
                <p className="text-xs text-muted-foreground">System Management</p>
              </div>
            </div>

            {/* Back Button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={getBackHref()}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full border-border bg-background text-foreground hover:bg-accent hover:text-foreground cursor-pointer lg:px-2 xl:px-3"
                  >
                    <ArrowLeft className="h-4 w-4 lg:mr-0 xl:mr-2" />
                    <span className="lg:hidden xl:inline">{getBackLabel()}</span>
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" className="hidden lg:block xl:hidden">
                <p>{getBackLabel()}</p>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Navigation Links */}
          <nav className="flex-1 p-4 lg:p-2 xl:p-4">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;

              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>
                    <Link href={item.href} onClick={() => setMobileMenuOpen(false)}>
                      <div
                        className={`
                          flex items-start gap-3 p-3 lg:p-2 lg:justify-center xl:justify-start xl:p-3 rounded-lg cursor-pointer transition-colors mb-2
                          ${
                            isActive
                              ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30'
                              : 'text-foreground hover:bg-accent hover:text-foreground'
                          }
                        `}
                      >
                        <Icon className="h-5 w-5 mt-0.5 flex-shrink-0" />
                        <div className="lg:hidden xl:block">
                          <p className="font-medium text-sm">{item.name}</p>
                          <p
                            className={`text-xs mt-0.5 ${
                              isActive ? 'text-accent-cyan/70' : 'text-muted-foreground'
                            }`}
                          >
                            {item.description}
                          </p>
                        </div>
                      </div>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="hidden lg:block xl:hidden">
                    <p className="font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto pt-16 lg:pt-0">
          {children}
        </main>
      </div>
      </TooltipProvider>
    </RequireAdmin>
  );
}
