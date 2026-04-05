'use client';

import { useState } from 'react';
import { useUserManagement } from '@/hooks/useUserManagement';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Users, Shield, ShieldAlert, Loader2, Settings, MoreVertical, UserCog, UserMinus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { ManageUserSitesDialog } from '@/components/ManageUserSitesDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  const { users, loading, error, updateUserRole, getUserCounts, assignSiteToUser, removeSiteFromUser, deleteUser } = useUserManagement();
  const { user: currentUser } = useAuth();
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [manageSitesDialogOpen, setManageSitesDialogOpen] = useState(false);
  const [deleteConfirmDialogOpen, setDeleteConfirmDialogOpen] = useState(false);
  const [roleChangeDialogOpen, setRoleChangeDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ uid: string; email: string; role: 'user' | 'admin'; sites: string[] } | null>(null);
  const [userToDelete, setUserToDelete] = useState<{ uid: string; email: string } | null>(null);
  const [userToChangeRole, setUserToChangeRole] = useState<{ uid: string; email: string; currentRole: 'user' | 'admin'; newRole: 'user' | 'admin' } | null>(null);

  const counts = getUserCounts();

  const handleOpenManageSites = (userId: string, email: string, role: 'user' | 'admin', sites: string[]) => {
    setSelectedUser({ uid: userId, email, role, sites });
    setManageSitesDialogOpen(true);
  };

  const handleOpenRoleChangeDialog = (userId: string, email: string, currentRole: 'user' | 'admin') => {
    // Prevent user from demoting themselves
    if (userId === currentUser?.uid && currentRole === 'admin') {
      toast.error('Cannot Demote Yourself', {
        description: 'You cannot remove your own admin privileges.',
      });
      return;
    }

    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    setUserToChangeRole({ uid: userId, email, currentRole, newRole });
    setRoleChangeDialogOpen(true);
  };

  const handleConfirmRoleChange = async () => {
    if (!userToChangeRole) return;

    setUpdatingUser(userToChangeRole.uid);
    setRoleChangeDialogOpen(false);

    const action = userToChangeRole.newRole === 'admin' ? 'promote' : 'demote';

    try {
      await updateUserRole(userToChangeRole.uid, userToChangeRole.newRole);
      toast.success('Role Updated', {
        description: `${userToChangeRole.email} has been ${action}d to ${userToChangeRole.newRole}.`,
      });
    } catch (err: any) {
      toast.error('Update Failed', {
        description: err.message || 'Failed to update user role.',
      });
    } finally {
      setUpdatingUser(null);
      setUserToChangeRole(null);
    }
  };

  const handleOpenDeleteDialog = (userId: string, email: string) => {
    // Prevent user from deleting themselves
    if (userId === currentUser?.uid) {
      toast.error('Cannot Delete Yourself', {
        description: 'You cannot delete your own account.',
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
      toast.success('User Deleted', {
        description: `${userToDelete.email} has been permanently deleted.`,
      });
    } catch (err: any) {
      toast.error('Deletion Failed', {
        description: err.message || 'Failed to delete user.',
      });
    } finally {
      setDeletingUser(null);
      setUserToDelete(null);
    }
  };

  const formatDate = (timestamp: any) => {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
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

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
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
            <div className="p-3 bg-green-600 rounded-lg">
              <Shield className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{counts.admins}</p>
              <p className="text-sm text-muted-foreground">administrators</p>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-muted rounded-lg">
              <Users className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{counts.users}</p>
              <p className="text-sm text-muted-foreground">regular users</p>
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
                <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-muted-foreground">
                    No users found
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr
                    key={user.uid}
                    className="border-b border-border hover:bg-muted/50 transition-colors"
                  >
                    {/* User Info */}
                    <td className="p-4">
                      <div>
                        {user.displayName && (
                          <p className="text-foreground font-medium">{user.displayName}</p>
                        )}
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                        {user.uid === currentUser?.uid && (
                          <Badge className="mt-1 bg-accent-cyan text-gray-900 text-xs">You</Badge>
                        )}
                      </div>
                    </td>

                    {/* Role Badge */}
                    <td className="p-4">
                      {user.role === 'admin' ? (
                        <Badge className="bg-green-600 flex items-center gap-1 w-fit">
                          <ShieldAlert className="h-3 w-3" />
                          admin
                        </Badge>
                      ) : (
                        <Badge className="bg-secondary border border-border text-muted-foreground flex items-center gap-1 w-fit">
                          <Users className="h-3 w-3" />
                          user
                        </Badge>
                      )}
                    </td>

                    {/* Sites Count */}
                    <td className="p-4">
                      <span className="text-foreground">{user.sites?.length || 0}</span>
                      <span className="text-muted-foreground text-sm ml-1">
                        site{user.sites?.length !== 1 ? 's' : ''}
                      </span>
                    </td>

                    {/* Join Date */}
                    <td className="p-4 text-muted-foreground text-sm">
                      {formatDate(user.createdAt)}
                    </td>

                    {/* Actions */}
                    <td className="p-4">
                      <div className="flex items-center justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground! hover:bg-accent! cursor-pointer"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
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
                              disabled={updatingUser === user.uid || user.uid === currentUser?.uid && user.role === 'admin'}
                              className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                            >
                              {updatingUser === user.uid ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  Updating...
                                </>
                              ) : user.role === 'admin' ? (
                                <>
                                  <UserMinus className="h-4 w-4 mr-2" />
                                  demote to user
                                </>
                              ) : (
                                <>
                                  <UserCog className="h-4 w-4 mr-2" />
                                  promote to admin
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
                                  Deleting...
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
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Info Box */}
      {!loading && !error && users.length > 0 && (
        <div className="mt-6 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
          <p className="text-accent-cyan text-sm">
            <strong>Note:</strong> Admins have full access to the admin panel and can
            manage users, upload installer versions, and configure system settings. Regular users
            can only access the dashboard and their assigned sites.
          </p>
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
              {userToChangeRole?.newRole === 'admin' ? (
                <UserCog className="h-5 w-5 text-accent-cyan" />
              ) : (
                <UserMinus className="h-5 w-5 text-muted-foreground" />
              )}
              {userToChangeRole?.newRole === 'admin' ? 'promote to admin' : 'demote to user'}
            </DialogTitle>
            <DialogDescription className="text-foreground">
              Are you sure you want to {userToChangeRole?.newRole === 'admin' ? 'promote' : 'demote'}{' '}
              <strong className="text-foreground">{userToChangeRole?.email}</strong> to {userToChangeRole?.newRole}?
            </DialogDescription>
          </DialogHeader>
          <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4 my-4">
            <p className="text-accent-cyan text-sm">
              {userToChangeRole?.newRole === 'admin'
                ? 'Admins have full access to the admin panel and can manage users, upload installer versions, and configure system settings.'
                : 'Regular users can only access the dashboard and their assigned sites.'}
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setRoleChangeDialogOpen(false)}
              className="border-border bg-background text-foreground hover:bg-accent! hover:text-foreground! cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleConfirmRoleChange}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              {userToChangeRole?.newRole === 'admin' ? (
                <>
                  <UserCog className="h-4 w-4 mr-2" />
                  promote to admin
                </>
              ) : (
                <>
                  <UserMinus className="h-4 w-4 mr-2" />
                  demote to user
                </>
              )}
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
              Are you sure you want to delete <strong className="text-foreground">{userToDelete?.email}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4 my-4">
            <p className="text-red-300 text-sm">
              this action cannot be undone. All user data will be permanently removed.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmDialogOpen(false)}
              className="border-border bg-background text-foreground hover:bg-accent! hover:text-foreground! cursor-pointer"
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
