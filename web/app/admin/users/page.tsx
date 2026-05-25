'use client';

import { useState, useEffect } from 'react';
import { useUserManagement, type UserRole } from '@/hooks/useUserManagement';
import type { FirestoreTs } from '@/hooks/useFirestore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Users, Shield, ShieldAlert, Crown, Loader2, Settings, MoreVertical, UserCog, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { ManageUserSitesDialog } from '@/components/ManageUserSitesDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  member: 'standard access to assigned sites — view machines, dispatch commands, toggle per-machine settings.',
  admin: 'site-scoped elevated tier — everything a member can do, plus delete machines, edit stored display layouts, and manage site webhooks/settings on assigned sites.',
  superadmin: 'platform-wide god-mode — access every site, manage users and roles, upload installer versions, configure global settings. reserve for platform operators.',
};

const ROLE_LABELS: Record<UserRole, string> = {
  member: 'member',
  admin: 'admin',
  superadmin: 'superadmin',
};

interface DeletionCounts {
  sites?: number;
  machines?: number;
  [key: string]: number | undefined;
}

interface DeletionView {
  id: string;
  uid: string | null;
  actorUid: string | null;
  capability: string;
  outcome: string;
  timestamp: string | null;
  denyReason: string | null;
  counts: DeletionCounts | null;
}

interface UserActivity {
  lastSignInTime: string | null;
  lastRefreshTime: string | null;
  disabled: boolean;
}

/**
 * User Management Page
 *
 * Admin-only page for managing user roles and permissions.
 * Allows admins to:
 * - View all users
 * - Promote users to admin
 * - Demote admins to user
 */
export default function UserManagementPage() {
  const { user: currentUser, isSuperadmin } = useAuth();
  const { users, loading, error, updateUserRole, getUserCounts, assignSiteToUser, removeSiteFromUser, deleteUser } = useUserManagement(isSuperadmin);
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [manageSitesDialogOpen, setManageSitesDialogOpen] = useState(false);
  const [deleteConfirmDialogOpen, setDeleteConfirmDialogOpen] = useState(false);
  const [roleChangeDialogOpen, setRoleChangeDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ uid: string; email: string; role: UserRole; sites: string[] } | null>(null);
  const [userToDelete, setUserToDelete] = useState<{ uid: string; email: string } | null>(null);
  const [userToChangeRole, setUserToChangeRole] = useState<{ uid: string; email: string; currentRole: UserRole; newRole: UserRole } | null>(null);
  const [deletions, setDeletions] = useState<DeletionView[]>([]);
  const [activity, setActivity] = useState<Record<string, UserActivity>>({});

  const counts = getUserCounts();

  // Fetch the account-deletion audit feed once. Non-fatal: on error we log and
  // leave `deletions` empty so the panel renders its empty state.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch('/api/users/deletions');
        if (!response.ok) {
          console.error('Error fetching account deletions:', response.status);
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setDeletions(Array.isArray(body.deletions) ? body.deletions : []);
      } catch (err) {
        console.error('Error fetching account deletions:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch Firebase Auth sign-in metadata (last-seen) for the table. Page-level
  // rather than in useUserManagement: that hook is also used by ManageSitesDialog
  // on non-superadmin pages (roosts/dashboard/logs), where this superadmin-only
  // endpoint would 403. Non-fatal — the column renders "never" if it fails.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch('/api/users/activity');
        if (!response.ok) {
          console.error('Error fetching user activity:', response.status);
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setActivity(body.activity ?? {});
      } catch (err) {
        console.error('Error fetching user activity:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenManageSites = (userId: string, email: string, role: UserRole, sites: string[]) => {
    setSelectedUser({ uid: userId, email, role, sites });
    setManageSitesDialogOpen(true);
  };

  const handleOpenRoleChangeDialog = (userId: string, email: string, currentRole: UserRole) => {
    // Prevent self-demotion from superadmin — preserves the platform-admin guarantee
    // so a lone superadmin can't accidentally lock themselves out of user management.
    if (userId === currentUser?.uid && currentRole === 'superadmin') {
      toast.error('cannot demote yourself', {
        description: 'promote another superadmin first, then they can demote you.',
      });
      return;
    }

    // newRole starts equal to currentRole; user picks a new value in the dialog.
    setUserToChangeRole({ uid: userId, email, currentRole, newRole: currentRole });
    setRoleChangeDialogOpen(true);
  };

  const handleSelectNewRole = (role: UserRole) => {
    setUserToChangeRole((prev) => (prev ? { ...prev, newRole: role } : prev));
  };

  const handleConfirmRoleChange = async () => {
    if (!userToChangeRole) return;
    if (userToChangeRole.newRole === userToChangeRole.currentRole) {
      // No-op — dialog shouldn't allow this state but guard anyway.
      setRoleChangeDialogOpen(false);
      setUserToChangeRole(null);
      return;
    }

    setUpdatingUser(userToChangeRole.uid);
    setRoleChangeDialogOpen(false);

    try {
      await updateUserRole(userToChangeRole.uid, userToChangeRole.newRole);
      toast.success('role updated', {
        description: `${userToChangeRole.email} is now a ${ROLE_LABELS[userToChangeRole.newRole]}.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('update failed', {
        description: message || 'failed to update user role.',
      });
    } finally {
      setUpdatingUser(null);
      setUserToChangeRole(null);
    }
  };

  const handleOpenDeleteDialog = (userId: string, email: string) => {
    // Prevent user from deleting themselves
    if (userId === currentUser?.uid) {
      toast.error('cannot delete yourself', {
        description: 'you cannot delete your own account.',
      });
      return;
    }

    setUserToDelete({ uid: userId, email });
    setDeleteConfirmDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!userToDelete) return;

    setDeletingUser(userToDelete.uid);
    setDeleteConfirmDialogOpen(false);

    try {
      await deleteUser(userToDelete.uid);
      toast.success('user deleted', {
        description: `${userToDelete.email} has been permanently deleted.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('deletion failed', {
        description: message || 'failed to delete user.',
      });
    } finally {
      setDeletingUser(null);
      setUserToDelete(null);
    }
  };

  const formatDate = (timestamp: FirestoreTs) => {
    if (!timestamp) return 'N/A';
    const t = timestamp as { toDate?: () => Date } | null | undefined;
    const date = t && typeof t.toDate === 'function'
      ? t.toDate()
      : new Date(timestamp as number | string | Date);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground mb-2">user management</h1>
        <p className="text-muted-foreground">manage user roles and permissions</p>
      </div>

      {/* Stats Cards — ordered by ascending privilege so the platform tier sits last. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-accent-cyan rounded-lg">
              <Users className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{counts.total}</p>
              <p className="text-sm text-muted-foreground">total users</p>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-muted rounded-lg">
              <Users className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{counts.members}</p>
              <p className="text-sm text-muted-foreground">members</p>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-green-600 rounded-lg">
              <Shield className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{counts.admins}</p>
              <p className="text-sm text-muted-foreground">site admins</p>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-red-600 rounded-lg">
              <Crown className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{counts.superadmins}</p>
              <p className="text-sm text-muted-foreground">superadmins</p>
            </div>
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6">
          <p className="text-red-300">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
          <span className="ml-3 text-muted-foreground">loading users...</span>
        </div>
      )}

      {/* Users Table */}
      {!loading && !error && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-background/50">
                <th className="text-left p-4 text-sm font-medium text-foreground">user</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">role</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">sites</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">joined</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">last seen</th>
                <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    no users found
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const isDeleted = user.deletedAt != null;
                  return (
                  <tr
                    key={user.uid}
                    className={`border-b border-border hover:bg-muted/50 transition-colors${isDeleted ? ' opacity-60' : ''}`}
                  >
                    {/* User Info */}
                    <td className="p-4">
                      <div>
                        {user.displayName && (
                          <p className="text-foreground font-medium">{user.displayName}</p>
                        )}
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                        {user.uid === currentUser?.uid && (
                          <Badge className="mt-1 bg-accent-cyan text-gray-900 text-xs">you</Badge>
                        )}
                        {isDeleted && (
                          <div className="mt-1">
                            <Badge className="bg-secondary border border-border text-muted-foreground text-xs">
                              deleted
                            </Badge>
                            <p className="text-xs text-muted-foreground mt-1">
                              deleted by {user.deletedBy ?? 'admin'} · {formatDate(user.deletedAt)}
                            </p>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Role Badge */}
                    <td className="p-4">
                      {user.role === 'superadmin' ? (
                        <Badge className="bg-red-600 flex items-center gap-1 w-fit">
                          <Crown className="h-3 w-3" />
                          superadmin
                        </Badge>
                      ) : user.role === 'admin' ? (
                        <Badge className="bg-green-600 flex items-center gap-1 w-fit">
                          <ShieldAlert className="h-3 w-3" />
                          admin
                        </Badge>
                      ) : (
                        <Badge className="bg-secondary border border-border text-muted-foreground flex items-center gap-1 w-fit">
                          <Users className="h-3 w-3" />
                          member
                        </Badge>
                      )}
                    </td>

                    {/* Sites */}
                    <td className="p-4">
                      {user.role === 'admin' ? (
                        // Admins are site-scoped — show the exact sites they admin
                        // so superadmins can see at a glance who's responsible for what.
                        user.sites && user.sites.length > 0 ? (
                          <div className="flex flex-wrap gap-1 max-w-sm">
                            {user.sites.map((siteId) => (
                              <span
                                key={siteId}
                                className="rounded bg-green-600/15 border border-green-600/40 text-green-400 text-xs font-mono px-1.5 py-0.5"
                                title={`admin of ${siteId}`}
                              >
                                {siteId}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm italic">
                            no sites assigned
                          </span>
                        )
                      ) : user.role === 'superadmin' ? (
                        <span className="text-muted-foreground text-sm italic">
                          all sites
                        </span>
                      ) : (
                        <>
                          <span className="text-foreground">{user.sites?.length || 0}</span>
                          <span className="text-muted-foreground text-sm ml-1">
                            site{user.sites?.length !== 1 ? 's' : ''}
                          </span>
                        </>
                      )}
                    </td>

                    {/* Join Date */}
                    <td className="p-4 text-muted-foreground text-sm">
                      {formatDate(user.createdAt)}
                    </td>

                    {/* Last Seen — last refresh, falling back to last sign-in. */}
                    <td className="p-4 text-muted-foreground text-sm">
                      {(() => {
                        const lastSeen = activity[user.uid]?.lastRefreshTime ?? activity[user.uid]?.lastSignInTime;
                        if (!lastSeen) {
                          return <span className="italic text-muted-foreground">never</span>;
                        }
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{formatDate(lastSeen)}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{lastSeen}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })()}
                    </td>

                    {/* Actions — deleted accounts have no actionable operations. */}
                    <td className="p-4">
                      {isDeleted ? (
                        <div className="flex items-center justify-end text-muted-foreground">—</div>
                      ) : (
                      <div className="flex items-center justify-end">
                        <DropdownMenu>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground! hover:bg-accent! cursor-pointer"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>user options</p>
                            </TooltipContent>
                          </Tooltip>
                          <DropdownMenuContent align="end" className="bg-card border-border">
                            <DropdownMenuItem
                              onClick={() => handleOpenManageSites(user.uid, user.email, user.role, user.sites || [])}
                              className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                            >
                              <Settings className="h-4 w-4 mr-2" />
                              manage sites
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleOpenRoleChangeDialog(user.uid, user.email, user.role)}
                              disabled={updatingUser === user.uid || (user.uid === currentUser?.uid && user.role === 'superadmin')}
                              className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                            >
                              {updatingUser === user.uid ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  updating...
                                </>
                              ) : (
                                <>
                                  <UserCog className="h-4 w-4 mr-2" />
                                  change role...
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator className="bg-border" />
                            <DropdownMenuItem
                              onClick={() => handleOpenDeleteDialog(user.uid, user.email)}
                              disabled={deletingUser === user.uid || user.uid === currentUser?.uid}
                              className="text-red-400 hover:bg-red-950/30! hover:text-red-300! cursor-pointer focus:bg-red-950/30 focus:text-red-300"
                            >
                              {deletingUser === user.uid ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  deleting...
                                </>
                              ) : (
                                <>
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  delete user
                                </>
                              )}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      )}
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Account-deletions audit feed — self-deletes + admin-deletes, newest-first. */}
      {!loading && !error && (
        <div className="mt-6 bg-card border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">account deletions</h2>
          {deletions.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">no recent deletions</p>
          ) : (
            <ul className="divide-y divide-border">
              {deletions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                  <Badge className="bg-secondary border border-border text-muted-foreground text-xs">
                    {d.capability === 'USER_SELF_DELETE' ? 'self-delete' : 'admin-delete'}
                  </Badge>
                  <span className="font-mono text-foreground">{d.uid ?? 'unknown'}</span>
                  <span className="text-muted-foreground">{formatDate(d.timestamp)}</span>
                  <span className="text-muted-foreground">{d.outcome}</span>
                  {d.counts && (
                    <span className="text-muted-foreground">
                      {d.counts.sites ?? 0} site{d.counts.sites !== 1 ? 's' : ''} · {d.counts.machines ?? 0} machine{d.counts.machines !== 1 ? 's' : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Role-description cards — ascending privilege order, matches the stats cards above. */}
      {!loading && !error && users.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm font-semibold text-foreground">member</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ROLE_DESCRIPTIONS.member}
            </p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert className="h-4 w-4 text-green-500 flex-shrink-0" />
              <span className="text-sm font-semibold text-foreground">admin</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ROLE_DESCRIPTIONS.admin}
            </p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Crown className="h-4 w-4 text-red-400 flex-shrink-0" />
              <span className="text-sm font-semibold text-foreground">superadmin</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ROLE_DESCRIPTIONS.superadmin}
            </p>
          </div>
        </div>
      )}

      {/* Manage Sites Dialog */}
      {selectedUser && (
        <ManageUserSitesDialog
          open={manageSitesDialogOpen}
          onOpenChange={setManageSitesDialogOpen}
          userId={selectedUser.uid}
          userEmail={selectedUser.email}
          userRole={selectedUser.role}
          userSites={selectedUser.sites}
          onAssignSite={assignSiteToUser}
          onRemoveSite={removeSiteFromUser}
        />
      )}

      {/* Role Change Confirmation Dialog */}
      <Dialog open={roleChangeDialogOpen} onOpenChange={setRoleChangeDialogOpen}>
        <DialogContent className="border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <UserCog className="h-5 w-5 text-accent-cyan" />
              change role
            </DialogTitle>
            <DialogDescription className="text-foreground">
              choose a new role for <strong className="text-foreground">{userToChangeRole?.email}</strong>. current role: <strong className="text-foreground">{userToChangeRole ? ROLE_LABELS[userToChangeRole.currentRole] : ''}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <Select
              value={userToChangeRole?.newRole}
              onValueChange={(v) => handleSelectNewRole(v as UserRole)}
            >
              <SelectTrigger className="w-full bg-secondary border-border text-foreground">
                <SelectValue placeholder="select a role" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="member" className="text-foreground focus:bg-accent focus:text-foreground">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    member
                  </div>
                </SelectItem>
                <SelectItem value="admin" className="text-foreground focus:bg-accent focus:text-foreground">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-green-500" />
                    admin
                  </div>
                </SelectItem>
                <SelectItem value="superadmin" className="text-foreground focus:bg-accent focus:text-foreground">
                  <div className="flex items-center gap-2">
                    <Crown className="h-4 w-4 text-red-500" />
                    superadmin
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            {userToChangeRole && (
              <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
                <p className="text-accent-cyan text-sm">
                  {ROLE_DESCRIPTIONS[userToChangeRole.newRole]}
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setRoleChangeDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleConfirmRoleChange}
              disabled={!userToChangeRole || userToChangeRole.newRole === userToChangeRole.currentRole}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <UserCog className="h-4 w-4 mr-2" />
              save role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmDialogOpen} onOpenChange={setDeleteConfirmDialogOpen}>
        <DialogContent className="border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-400" />
              delete user
            </DialogTitle>
            <DialogDescription className="text-foreground">
              are you sure you want to delete <strong className="text-foreground">{userToDelete?.email}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4 my-4">
            <p className="text-red-300 text-sm">
              this action cannot be undone. all user data will be permanently removed.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setDeleteConfirmDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
