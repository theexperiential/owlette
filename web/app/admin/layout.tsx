'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import RequireSuperadmin from '@/components/RequireSuperadmin';
import { Users, Package, ArrowLeft, Menu, X, Settings, Mail, KeyRound, Webhook, Clock, Bell, CreditCard, Wallet, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDevicePrefFlag } from '@/hooks/useDevicePrefFlag';

/**
 * Admin Layout
 *
 * Wraps all admin pages with:
 * - Superadmin permission check (RequireSuperadmin component)
 * - Navigation sidebar for admin sections
 * - Consistent styling
 * - Mobile responsive with hamburger menu
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Desktop sidebar collapse (icon-only), persisted per device. Replaces the
  // former viewport-driven lg/xl auto-collapse with an explicit user control so
  // the width is predictable regardless of window size. Mobile (<lg) always
  // uses the full-width drawer, so this only governs the lg+ static sidebar.
  const { value: collapsed, setValue: setCollapsed } = useDevicePrefFlag('adminSidebarCollapsed', false);

  const navItems = [
    {
      name: 'installers',
      href: '/admin/installers',
      icon: Package,
      description: 'manage agent installer versions',
    },
    {
      name: 'template library',
      href: '/admin/presets',
      icon: Settings,
      description: 'manage software catalog',
    },
    {
      name: 'users',
      href: '/admin/users',
      icon: Users,
      description: 'manage user roles and permissions',
    },
    {
      name: 'agent tokens',
      href: '/admin/tokens',
      icon: KeyRound,
      description: 'view and revoke agent tokens',
    },
    {
      name: 'billing',
      href: '/admin/billing',
      icon: CreditCard,
      description: 'revenue, conversion, and storage pressure',
    },
    {
      name: 'customers',
      href: '/admin/customers',
      icon: Wallet,
      description: 'extend trials, comp tiers, force expiry',
    },
    {
      name: 'schedules',
      href: '/admin/schedules',
      icon: Clock,
      description: 'manage schedule presets',
    },
    {
      name: 'alerts',
      href: '/admin/alerts',
      icon: Bell,
      description: 'manage alert rules',
    },
    {
      name: 'webhooks',
      href: '/admin/webhooks',
      icon: Webhook,
      description: 'configure webhook integrations',
    },
    {
      name: 'email',
      href: '/admin/email',
      icon: Mail,
      description: 'email configuration & testing',
    },
  ];

  // Read sessionStorage in a lazy initializer so the initial render already
  // has the correct back-target — avoids a post-mount setState inside an
  // effect (which violates react-hooks/set-state-in-effect). Guarded on
  // `window` for SSR safety; falls back to the dashboard when unavailable.
  const [{ backLabel, backPath }] = useState(() => {
    if (typeof window === 'undefined') return { backLabel: 'go back', backPath: '/dashboard' };
    const prev = sessionStorage.getItem('owlette_pre_admin_path');
    if (!prev) return { backLabel: 'go back', backPath: '/dashboard' };
    const name = prev.replace(/^\//, '').split('/')[0] || 'dashboard';
    return { backLabel: `back to ${name}`, backPath: prev };
  });

  // Jump directly to the pre-admin path instead of router.back() — the back-button
  // should skip over any admin → admin internal navigation the user took on the way in.
  const handleBack = () => {
    router.push(backPath);
  };

  // Icon-only collapse control, floated in the header corner when expanded.
  // (Expanding is handled by the owl-eye logo itself when collapsed — see the
  // header block below — so this only ever collapses.)
  const renderCollapseButton = () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCollapsed(true)}
          aria-label="collapse sidebar"
          className="shrink-0 text-muted-foreground hover:text-foreground! hover:bg-accent! cursor-pointer"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>collapse sidebar</p>
      </TooltipContent>
    </Tooltip>
  );

  return (
    <RequireSuperadmin>
      <TooltipProvider delayDuration={100}>
        <div className="flex min-h-screen">
        {/* Mobile Menu Button */}
        {!mobileMenuOpen && (
          <div className="lg:hidden fixed top-4 left-4 z-50">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMobileMenuOpen(true)}
              className="border-border bg-muted/95 backdrop-blur-sm text-foreground hover:bg-muted! cursor-pointer shadow-lg"
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
          w-64 ${collapsed ? 'lg:w-20' : 'lg:w-64'} bg-card border-r border-border flex flex-col
          fixed lg:static inset-y-0 left-0 z-40
          transform transition-all duration-200 ease-in-out
          ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}>
          {/* Header — vertical padding is held constant across states (only the
              horizontal shrinks when collapsed) so the logo doesn't shift up or
              down as the rail folds. */}
          <div className={`p-6 ${collapsed ? 'lg:px-3 lg:py-6' : 'lg:p-6'} border-b border-border`}>
            {/* Mobile Header */}
            <div className="lg:hidden mb-4">
              <div className="flex items-center justify-between mb-2">
                <h1 className="text-xl font-bold text-foreground">admin panel</h1>
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 hover:bg-muted! rounded-lg transition-colors cursor-pointer"
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground">system management</p>
            </div>

            {/* Desktop/Tablet Header — fixed row height + constant logo size in
                both states, so the owl eye lands at the exact same y whether the
                rail is expanded or collapsed (no vertical jump on toggle). */}
            <div className={`hidden lg:flex items-center h-11 mb-4 ${collapsed ? 'justify-center' : 'relative gap-2'}`}>
              {collapsed ? (
                /* Collapsed: the owl-eye logo doubles as the expand control —
                   at rest it's the logo, on hover/focus it swaps to an expand
                   icon. Folding the two together saves a row on the icon rail.
                   Desktop only; mobile uses the drawer's own close (X). */
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setCollapsed(false)}
                      aria-label="expand sidebar"
                      className="group relative flex items-center justify-center h-10 w-10 rounded-lg transition-colors hover:bg-accent! focus-visible:bg-accent! outline-none cursor-pointer"
                    >
                      <Image
                        src="/owlette-icon.png"
                        alt="Owlette"
                        width={36}
                        height={36}
                        className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <PanelLeftOpen className="absolute h-5 w-5 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>expand sidebar</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <>
                  <div className="flex-shrink-0">
                    <Image src="/owlette-icon.png" alt="Owlette" width={36} height={36} />
                  </div>
                  <div className="block pr-8">
                    <h1 className="text-xl font-bold text-foreground">admin panel</h1>
                    <p className="text-xs text-muted-foreground">system management</p>
                  </div>
                  {/* Collapse control — icon-only, floated at the row's right
                      edge, vertically centered on the logo; the title's pr-8
                      keeps text clear of it. */}
                  <div className="absolute right-0 top-1/2 -translate-y-1/2">
                    {renderCollapseButton()}
                  </div>
                </>
              )}
            </div>

            {/* Back Button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBack}
                  className={`w-full border-border bg-background text-foreground hover:bg-accent! hover:text-foreground! cursor-pointer ${collapsed ? 'lg:px-2' : 'lg:px-3'}`}
                >
                  <ArrowLeft className={`h-4 w-4 ${collapsed ? 'lg:mr-0' : 'lg:mr-2'}`} />
                  <span className={collapsed ? 'inline lg:hidden' : 'inline'}>{backLabel}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className={collapsed ? 'hidden lg:block' : 'hidden'}>
                <p>{backLabel}</p>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Navigation Links */}
          <nav className={`flex-1 p-4 ${collapsed ? 'lg:p-2' : 'lg:p-4'}`}>
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;

              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>
                    <Link href={item.href} onClick={() => setMobileMenuOpen(false)}>
                      <div
                        className={`
                          flex items-start gap-3 p-3 ${collapsed ? 'lg:p-2 lg:justify-center' : 'lg:p-3 lg:justify-start'} rounded-lg cursor-pointer transition-colors mb-2
                          ${
                            isActive
                              ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30'
                              : 'text-foreground hover:bg-accent! hover:text-foreground!'
                          }
                        `}
                      >
                        <Icon className="h-5 w-5 mt-0.5 flex-shrink-0" />
                        <div className={`block ${collapsed ? 'lg:hidden' : 'lg:block'}`}>
                          <p className="font-medium text-sm">{item.name}</p>
                          <p
                            className={`text-xs mt-0.5 ${
                              isActive ? 'text-accent-cyan' : 'text-muted-foreground'
                            }`}
                          >
                            {item.description}
                          </p>
                        </div>
                      </div>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" className={collapsed ? 'hidden lg:block' : 'hidden'}>
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
    </RequireSuperadmin>
  );
}
