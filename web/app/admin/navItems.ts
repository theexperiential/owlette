/**
 * Admin panel destinations and the role gate over them.
 *
 * Its own module rather than `layout.tsx` because Next validates route files'
 * exports — a layout may only export `default` and the segment config keys.
 */

import {
  Users,
  UserPlus,
  Package,
  Settings,
  Mail,
  KeyRound,
  Webhook,
  Clock,
  Bell,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '@/contexts/AuthContext';

/** Lowest global role a destination admits; 'admin' also admits superadmins. */
export type AdminMinRole = 'admin' | 'superadmin';

export interface AdminNavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  description: string;
  minRole: AdminMinRole;
}

const NAV_ITEMS: AdminNavItem[] = [
  {
    name: 'installers',
    href: '/admin/installers',
    icon: Package,
    description: 'manage agent installer versions',
    minRole: 'superadmin',
  },
  {
    name: 'template library',
    href: '/admin/presets',
    icon: Settings,
    description: 'manage software catalog',
    minRole: 'superadmin',
  },
  {
    name: 'members',
    href: '/admin/members',
    icon: UserPlus,
    description: 'manage site members',
    minRole: 'admin',
  },
  {
    name: 'users',
    href: '/admin/users',
    icon: Users,
    description: 'manage user roles and permissions',
    minRole: 'superadmin',
  },
  {
    name: 'agent tokens',
    href: '/admin/tokens',
    icon: KeyRound,
    description: 'view and revoke agent tokens',
    minRole: 'admin',
  },
  {
    name: 'schedules',
    href: '/admin/schedules',
    icon: Clock,
    description: 'manage schedule presets',
    minRole: 'admin',
  },
  {
    name: 'alerts',
    href: '/admin/alerts',
    icon: Bell,
    description: 'manage alert rules',
    minRole: 'admin',
  },
  {
    name: 'webhooks',
    href: '/admin/webhooks',
    icon: Webhook,
    description: 'configure webhook integrations',
    minRole: 'admin',
  },
  {
    name: 'email',
    href: '/admin/email',
    icon: Mail,
    description: 'email configuration & testing',
    minRole: 'superadmin',
  },
];

/** Superadmins see the whole panel; admins only the site-scoped destinations. */
export function visibleNavItems(role: UserRole | null): AdminNavItem[] {
  if (role === 'superadmin') return NAV_ITEMS;
  if (role === 'admin') return NAV_ITEMS.filter((item) => item.minRole === 'admin');
  return [];
}

/**
 * Role a pathname demands. Subpaths inherit their page's requirement; anything
 * with no matching nav entry fails closed to superadmin.
 */
export function requiredRoleForPath(pathname: string | null): AdminMinRole {
  const match = NAV_ITEMS.find(
    (item) => pathname === item.href || !!pathname?.startsWith(`${item.href}/`)
  );
  return match?.minRole ?? 'superadmin';
}
