'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useOwletteChat, type ChatConversation } from '@/hooks/useHoot';
import { useHootSidebarPrefs } from '@/hooks/useHootSidebarPrefs';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { Button } from '@/components/ui/button';
import { Plus, MessageSquare, Trash2, Brain, KeyRound, Check, X, Zap, Search, Loader2, Pencil, ChevronRight, ChevronsDownUp, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, RotateCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ChatWindow } from './ChatWindow';
import { ChatInput } from './ChatInput';
import { MachineSelector, SITE_TARGET_ID } from './MachineSelector';
import { HootPowerToggle } from './HootPowerToggle';
import { HootApprovalToggle } from './HootApprovalToggle';
import { LoadingWord } from '@/components/LoadingWord';

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

/** Group conversations by category for sidebar display. */
function groupConversationsByCategory(
  conversations: ChatConversation[]
): { label: string; conversations: ChatConversation[] }[] {
  const groups: Record<string, ChatConversation[]> = {};

  for (const convo of conversations) {
    const label = convo.category || 'General';
    (groups[label] ??= []).push(convo);
  }

  // Sort groups: most recently updated first, "General" always last
  return Object.entries(groups)
    .sort(([a, aConvos], [b, bConvos]) => {
      if (a === 'General') return 1;
      if (b === 'General') return -1;
      const aLatest = Math.max(...aConvos.map((c) => c.updatedAt.getTime()));
      const bLatest = Math.max(...bConvos.map((c) => c.updatedAt.getTime()));
      return bLatest - aLatest;
    })
    .map(([label, convos]) => ({ label, conversations: convos }));
}

interface HootChatViewProps {
  initialChatId?: string;
}

export function HootChatView({ initialChatId }: HootChatViewProps) {
  const router = useRouter();
  const { user, userSites, isSuperadmin, isSiteAdmin, loading: authLoading, lastSiteId, lastMachineIds, updateLastSite, updateLastMachine } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isSuperadmin);

  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [selectedMachineId, setSelectedMachineId] = useState<string>(SITE_TARGET_ID);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'profile' | 'hoot'>('profile');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [categorizingAll, setCategorizingAll] = useState(false);
  // Sidebar expand/collapse state persists per-device to Firestore.
  const { sidebarOpen, setSidebarOpen, collapsedGroups, setCollapsedGroups } = useHootSidebarPrefs();
  // Below `md` the sidebar has no room, so the conversation list moves into a
  // left-slide sheet. Transient UI state on purpose — unlike `sidebarOpen` it is
  // NOT persisted to devicePrefs; a sheet that reopened itself on every visit
  // would bury the chat behind an overlay.
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  // Viewport-aware branching between the desktop aside and the mobile sheet.
  // `md:hidden` on the sheet is NOT sufficient — Radix portals the overlay +
  // content into document.body, escaping any wrapper class. Only JS gating keeps
  // the mobile overlay off the desktop viewport. It also guarantees the
  // conversation list is mounted on exactly ONE surface at a time, which
  // `sidebarScrollRef` / `loadMoreSentinelRef` depend on (see below).
  // Starts `true` so SSR and hydration agree; the effect corrects it on mount.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    const onChange = () => {
      sync();
      // Crossing up into the desktop layout unmounts the sheet; drop the open
      // flag too so coming back down doesn't reopen it over the chat.
      if (mq.matches) setMobileConversationsOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const { machines } = useMachines(currentSiteId);

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (sites.length > 0 && !currentSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      const siteId = savedSite && sites.some((s) => s.id === savedSite) ? savedSite : sites[0].id;
      setCurrentSiteId(siteId);
      if (lastMachineIds[siteId]) setSelectedMachineId(lastMachineIds[siteId]);
    }
  }, [sites, currentSiteId, lastSiteId, lastMachineIds]);

  const handleSiteChange = (siteId: string) => {
    setCurrentSiteId(siteId);
    setSelectedMachineId(lastMachineIds[siteId] || SITE_TARGET_ID);
    updateLastSite(siteId);
  };

  // Reset to "All Machines" if the saved machine no longer exists on this site
  useEffect(() => {
    if (
      selectedMachineId !== SITE_TARGET_ID &&
      machines.length > 0 &&
      !machines.some((m) => m.machineId === selectedMachineId)
    ) {
      setSelectedMachineId(SITE_TARGET_ID);
    }
  }, [machines, selectedMachineId]);

  const isSiteMode = selectedMachineId === SITE_TARGET_ID;
  const selectedMachine = !isSiteMode ? machines.find((m) => m.machineId === selectedMachineId) : null;
  const suppressNextChatRouteRef = useRef(false);
  const skipNextLandingResetRef = useRef(false);
  // The routed chat id we've navigated away from (via handleNewChat /
  // handleDeleteChat) while the URL still points at it. router.push is async, so
  // until the pathname commits, initialChatId lags at this stale id while
  // activeChatId is already the new chat. The load effect must not reload the
  // stale id — that would steal selection from the just-created chat. A one-shot
  // boolean is insufficient: the load effect re-runs on *every* render (its
  // `loadChat` dep is rebuilt each render because the AI SDK's useChat returns a
  // fresh object), so the flag would be spent on the first of the several renders
  // in the navigation window and the next reload would slip through. Storing the
  // id makes the guard hold for the whole window; the effect clears it once the
  // pathname catches up (initialChatId moves off this id).
  const staleRoutedChatIdRef = useRef<string | null>(null);
  const previousChatIdRef = useRef<string | null>(null);
  const previousInitialChatIdRef = useRef<string | undefined>(initialChatId);

  const handleChatPersisted = useCallback((persistedChatId: string) => {
    if (!initialChatId) {
      router.replace(`/hoot/${encodeURIComponent(persistedChatId)}`);
    }
  }, [initialChatId, router]);

  const chat = useOwletteChat({
    siteId: currentSiteId,
    machineId: selectedMachineId,
    machineName: isSiteMode ? 'All Machines' : selectedMachineId,
    onChatPersisted: handleChatPersisted,
  });
  const activeChatId = chat.chatId;
  const loadChat = chat.loadChat;

  useEffect(() => {
    // Once the pathname commits, initialChatId moves off the stale id (to the new
    // chat's URL or back to the landing) — the navigation window is over, so retire
    // the guard and make that chat loadable again on a future navigation.
    if (staleRoutedChatIdRef.current !== null && initialChatId !== staleRoutedChatIdRef.current) {
      staleRoutedChatIdRef.current = null;
    }
    if (!initialChatId || initialChatId === activeChatId) return;
    // A just-started new chat (or a deletion) navigated away from initialChatId,
    // but the pathname hasn't committed yet so it still reads the stale id. Don't
    // reload it — that would steal selection from the just-created chat.
    if (initialChatId === staleRoutedChatIdRef.current) return;
    void loadChat(initialChatId);
  }, [initialChatId, activeChatId, loadChat]);

  useEffect(() => {
    const previousChatId = previousChatIdRef.current;
    previousChatIdRef.current = activeChatId;

    if (!previousChatId || previousChatId === activeChatId) return;
    if (suppressNextChatRouteRef.current) {
      suppressNextChatRouteRef.current = false;
      return;
    }

    if (initialChatId && activeChatId !== initialChatId) {
      router.replace(`/hoot/${encodeURIComponent(activeChatId)}`);
    }
  }, [activeChatId, initialChatId, router]);

  // Landing transition: when the URL goes from a routed chat back to /hoot
  // (browser back, or a deletion), start a fresh chat. Skipped when an explicit
  // handler (handleNewChat / handleDeleteChat) already started one. With the
  // persistent layout the component is not remounted, so this fires on the
  // initialChatId prop change rather than on mount.
  useEffect(() => {
    const previousInitialChatId = previousInitialChatIdRef.current;
    previousInitialChatIdRef.current = initialChatId;

    if (initialChatId || !previousInitialChatId) return;
    if (skipNextLandingResetRef.current) {
      skipNextLandingResetRef.current = false;
      return;
    }

    suppressNextChatRouteRef.current = true;
    chat.startNewChat();
  }, [chat, initialChatId]);

  // Reset error dismissed state when a new error arrives
  useEffect(() => {
    if (chat.error) setErrorDismissed(false);
  }, [chat.error]);

  // Per-commandId cancel-in-flight state. Lives here (next to the async
  // handler) — ChatWindow just derives a per-card boolean from the Set.
  const [cancelPendingCommandIds, setCancelPendingCommandIds] = useState<Set<string>>(new Set());
  const cancelTool = chat.cancelTool;
  const handleCancelTool = useCallback(async (commandId: string) => {
    setCancelPendingCommandIds((prev) => {
      const next = new Set(prev);
      next.add(commandId);
      return next;
    });
    try {
      await cancelTool(commandId);
    } finally {
      setCancelPendingCommandIds((prev) => {
        const next = new Set(prev);
        next.delete(commandId);
        return next;
      });
    }
  }, [cancelTool]);

  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  const handleNewChat = useCallback((overrides?: { machineId?: string; machineName?: string }) => {
    // The sheet is the only way to reach "new conversation" on mobile, so
    // starting one has to dismiss it and reveal the chat. No-op on desktop,
    // where the flag is never set.
    setMobileConversationsOpen(false);
    if (initialChatId) {
      // Navigate back to the landing URL but keep it there until the chat is
      // persisted (handleChatPersisted replaces to /hoot/{id}). suppress stops
      // the URL-sync effect from pushing the unsaved id; skipNextLandingReset
      // stops the landing effect from starting a *second* new chat.
      suppressNextChatRouteRef.current = true;
      skipNextLandingResetRef.current = true;
      staleRoutedChatIdRef.current = initialChatId;
      router.push('/hoot');
    }

    chat.startNewChat(overrides);
    sidebarScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [chat, initialChatId, router]);

  const handleConversationClick = useCallback((conversationId: string) => {
    // Same as handleNewChat: selecting a conversation on mobile means the user
    // is done with the list, so close the sheet onto the chat they picked.
    setMobileConversationsOpen(false);
    // Expand the selected conversation's category group if the user had it
    // collapsed, so the row it lives in is actually visible after selecting.
    const convo = conversationsRef.current.find((c) => c.id === conversationId);
    if (convo && convo.title !== 'new conversation') {
      const label = convo.category || 'General';
      setCollapsedGroups((prev) => {
        if (!prev.has(label)) return prev;
        const next = new Set(prev);
        next.delete(label);
        return next;
      });
    }
    router.push(`/hoot/${encodeURIComponent(conversationId)}`);
  }, [router, setCollapsedGroups]);

  const handleDeleteChat = useCallback((conversationId: string) => {
    const deletedRouteChat = conversationId === initialChatId;
    if (deletedRouteChat) {
      suppressNextChatRouteRef.current = true;
      skipNextLandingResetRef.current = true;
      staleRoutedChatIdRef.current = conversationId;
    }

    void chat.deleteChat(conversationId);

    if (deletedRouteChat) {
      router.replace('/hoot');
    }
  }, [chat, initialChatId, router]);

  // Infinite scroll: auto-load more conversations when the sentinel scrolls into view
  const { hasMoreConversations, loadingMore, loadMoreConversations } = chat;
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = sidebarScrollRef.current;
    if (!sentinel || !root || !hasMoreConversations || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreConversations();
      },
      { root, rootMargin: '200px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `isDesktop` / `mobileConversationsOpen` are deps even though the effect
    // never reads them: they decide WHICH surface holds the scroller and the
    // sentinel, and remounting the list swaps the nodes these refs point at.
    // Without them the observer would stay bound to a detached node (or never
    // attach at all when the list first mounts inside the sheet).
  }, [hasMoreConversations, loadingMore, loadMoreConversations, isDesktop, mobileConversationsOpen]);

  // Latest conversations, readable from event handlers without re-subscribing.
  const conversationsRef = useRef(chat.conversations);
  conversationsRef.current = chat.conversations;

  // Scroll the active conversation row into view whenever the active chat changes
  // (selecting a conversation, starting a new one), so the highlighted row is
  // never left scrolled out of sight. No state writes here — purely a DOM nudge.
  // Also re-runs when the list moves between the desktop aside and the mobile
  // sheet, so a freshly-opened sheet lands on the current conversation instead
  // of at the top of the list.
  useEffect(() => {
    if (!chat.chatId) return;
    const raf = requestAnimationFrame(() => {
      sidebarScrollRef.current
        ?.querySelector<HTMLElement>('[data-active-conversation="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [chat.chatId, isDesktop, mobileConversationsOpen]);

  // Skip "new conversation" entries — the API requires a title or first message to categorize
  const uncategorizedIds = chat.conversations
    .filter((c) => !c.category && c.title !== 'new conversation')
    .map((c) => c.id);

  // Drive the collapse-all/expand-all toggle off the *actual* set of visible
  // group labels so the icon/label and the action never disagree (e.g. one
  // section expanded while the rest are collapsed).
  const visibleGroupLabels = groupConversationsByCategory(
    chat.conversations.filter((c) => c.title !== 'new conversation'),
  ).map((g) => g.label);
  const allGroupsCollapsed =
    visibleGroupLabels.length > 0 && visibleGroupLabels.every((l) => collapsedGroups.has(l));

  // Which category the active conversation lives in — used to flag a collapsed
  // section that contains the current chat, so the user knows where it is.
  const activeConvo = chat.conversations.find((c) => c.id === chat.chatId);
  const activeCategoryLabel = activeConvo && activeConvo.title !== 'new conversation'
    ? (activeConvo.category || 'General')
    : null;

  const categorizeAll = async () => {
    if (categorizingAll || uncategorizedIds.length === 0) return;
    setCategorizingAll(true);
    try {
      const res = await fetch('/api/hoot/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatIds: uncategorizedIds, siteId: currentSiteId }),
      });
      // Apply returned categories to local state (loadMore conversations
      // aren't watched by the snapshot listener, so we patch them here)
      if (res.ok) {
        const { results } = await res.json() as { results: Record<string, string> };
        if (results && Object.keys(results).length > 0) {
          chat.updateConversationCategories(results);
        }
      }
    } catch {
      // silent
    } finally {
      setCategorizingAll(false);
    }
  };

  // Check if user or site has an LLM API key configured
  useEffect(() => {
    if (!user || !db) return;
    async function checkApiKey() {
      try {
        // Check user-level key
        const userKeyDoc = await getDoc(doc(db!, 'users', user!.uid, 'settings', 'llm'));
        if (userKeyDoc.exists()) {
          setHasApiKey(true);
          return;
        }
        // Check site-level key
        if (currentSiteId) {
          const siteKeyDoc = await getDoc(doc(db!, 'sites', currentSiteId, 'settings', 'llm'));
          if (siteKeyDoc.exists()) {
            setHasApiKey(true);
            return;
          }
        }
        setHasApiKey(false);
      } catch {
        // If we can't read the settings doc, assume no key configured
        setHasApiKey(false);
      }
    }
    checkApiKey();
  }, [user, currentSiteId, accountSettingsOpen]);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  const showConversationNotFound = Boolean(initialChatId && chat.chatLoadError === 'not_found');

  // The desktop aside animates between `w-64` and `w-0`, so its children carry a
  // fixed width to stop the content reflowing mid-collapse. In the mobile sheet
  // the shell owns the width instead, and a fixed 256px child would leave a gap.
  const conversationPanelWidth = isDesktop ? 'w-64 min-w-64' : 'w-full min-w-0';

  if (authLoading || sitesLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground"><LoadingWord /></div>
      </div>
    );
  }

  if (!user) return null;

  return (
    // `h-dvh`, not `h-screen`: on iOS Safari `100vh` is the URL-bar-collapsed
    // height, so a full-height shell overflows by the height of the visible
    // browser chrome and pushes the composer below the fold.
    <div className="h-dvh flex flex-col">
      <PageHeader
        currentPage="hoot"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => {}}
        onAccountSettings={() => setAccountSettingsOpen(true)}
      />

      <div className="flex-1 flex min-h-0 relative max-w-screen-2xl mx-auto w-full gap-3 p-3 md:p-4">

        {/* No API key overlay */}
        {hasApiKey === false && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="text-center max-w-md px-4">
              <Brain className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">hoot</h3>
              <p className="text-sm text-muted-foreground mb-6">
                debug, diagnose, and manage your remote machines.
              </p>
              <div className="rounded-lg border border-border bg-secondary p-5">
                <KeyRound className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground mb-3">
                  hoot requires an LLM API key. add your anthropic or openai key in account settings.
                </p>
                <button
                  onClick={() => { setSettingsInitialSection('hoot'); setAccountSettingsOpen(true); }}
                  className="text-xs px-4 py-2 rounded-md bg-accent-cyan text-gray-900 font-medium hover:bg-accent-cyan/90 transition-colors cursor-pointer"
                >
                  open account settings
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Conversation list. Above `md` this is the collapsible aside beside
            the chat; below it, the same children render inside a left-slide
            sheet reached from the header button. Exactly one surface mounts at
            a time — see ConversationPanelShell. */}
        <ConversationPanelShell
          isDesktop={isDesktop}
          sidebarOpen={sidebarOpen}
          mobileOpen={mobileConversationsOpen}
          onMobileOpenChange={setMobileConversationsOpen}
        >
          <div className={`${conversationPanelWidth} h-12 px-2 border-b border-border flex items-center gap-1`}>
            {searchOpen ? (
              /* Search mode: compact new chat + expanded input */
              <>
                <Button
                  onClick={() => handleNewChat()}
                  variant="ghost"
                  size="icon"
                  aria-label="new conversation"
                  className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    autoFocus
                    placeholder="search..."
                    value={chat.searchQuery}
                    onChange={(e) => chat.setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        chat.setSearchQuery('');
                        setSearchOpen(false);
                      }
                    }}
                    className="h-8 pl-7 pr-7 text-xs bg-secondary border-border"
                  />
                  <button
                    onClick={() => { chat.setSearchQuery(''); setSearchOpen(false); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                  >
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground transition-colors" />
                  </button>
                </div>
              </>
            ) : (
              /* Default: new conversation button + section toggle + search icon */
              <>
                <Button
                  onClick={() => handleNewChat()}
                  variant="ghost"
                  size="sm"
                  className="flex-1 min-w-0 h-8 text-foreground"
                >
                  <Plus className="h-4 w-4 mr-2 flex-shrink-0" />
                  <span className="truncate">new conversation</span>
                </Button>
                {!chat.searchQuery && chat.conversations.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => {
                          setCollapsedGroups(allGroupsCollapsed ? new Set() : new Set(visibleGroupLabels));
                        }}
                        variant="ghost"
                        size="icon"
                        aria-label={allGroupsCollapsed ? 'expand conversation groups' : 'collapse conversation groups'}
                        className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                      >
                        {allGroupsCollapsed ? (
                          <ChevronsUpDown className="h-4 w-4" />
                        ) : (
                          <ChevronsDownUp className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{allGroupsCollapsed ? 'expand all' : 'collapse all'}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={() => setSearchOpen(true)}
                      variant="ghost"
                      size="icon"
                      aria-label="search conversations"
                      className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                    >
                      <Search className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>search conversations</p>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>

          <div
            ref={sidebarScrollRef}
            className={`${conversationPanelWidth} flex-1 overflow-y-auto ${isDesktop ? 'border-r border-border' : ''}`}
          >
            {chat.conversations.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {chat.searchQuery ? 'no matches' : 'no conversations yet'}
              </div>
            ) : chat.searchQuery ? (
              /* Flat list when searching — no grouping */
              <div className="py-1">
                {chat.conversations.map((convo) => (
                  <ConversationItem
                    key={convo.id}
                    conversation={convo}
                    isActive={convo.id === chat.chatId}
                    onClick={() => handleConversationClick(convo.id)}
                    onDelete={() => handleDeleteChat(convo.id)}
                    onRename={(title) => chat.renameChat(convo.id, title)}
                  />
                ))}
              </div>
            ) : (
              /* New conversations pinned to top, then grouped by category */
              <div className="py-1">
                {/* Unsaved "New conversation" entries always at top */}
                {chat.conversations
                  .filter((c) => c.title === 'new conversation')
                  .map((convo) => (
                    <ConversationItem
                      key={convo.id}
                      conversation={convo}
                      isActive={convo.id === chat.chatId}
                      onClick={() => handleConversationClick(convo.id)}
                      onDelete={() => handleDeleteChat(convo.id)}
                      onRename={(title) => chat.renameChat(convo.id, title)}
                    />
                  ))}
                {groupConversationsByCategory(
                  chat.conversations.filter((c) => c.title !== 'new conversation')
                ).map((group) => {
                  const isCollapsed = collapsedGroups.has(group.label);
                  // Highlight the header of whichever group holds the active
                  // conversation — collapsed (where the row is hidden) or expanded.
                  const containsActive = group.label === activeCategoryLabel;
                  return (
                    <div key={group.label}>
                      <button
                        onClick={() => setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.label)) next.delete(group.label);
                          else next.add(group.label);
                          return next;
                        })}
                        className="w-full flex items-center gap-1 px-3 py-2.5 mt-1.5 first:mt-0 cursor-pointer hover:bg-accent/30 transition-colors"
                      >
                        <ChevronRight className={`h-3 w-3 transition-transform ${isCollapsed ? '' : 'rotate-90'} ${containsActive ? 'text-accent-cyan' : 'text-muted-foreground/50'}`} />
                        <span className={`text-xs font-medium uppercase tracking-wider ${containsActive ? 'text-accent-cyan' : 'text-muted-foreground/70'}`}>
                          {group.label}
                        </span>
                        {containsActive && isCollapsed && (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan flex-shrink-0" aria-hidden />
                            <span className="sr-only">contains the current conversation</span>
                          </>
                        )}
                        <span className="text-xs text-muted-foreground/40 ml-auto">
                          {group.conversations.length}
                        </span>
                      </button>
                      {!isCollapsed && group.conversations.map((convo) => (
                        <ConversationItem
                          key={convo.id}
                          conversation={convo}
                          isActive={convo.id === chat.chatId}
                          onClick={() => handleConversationClick(convo.id)}
                          onDelete={() => handleDeleteChat(convo.id)}
                          onRename={(title) => chat.renameChat(convo.id, title)}
                        />
                      ))}
                    </div>
                  );
                })}

                {/* Categorize uncategorized conversations */}
                {uncategorizedIds.length > 0 && (
                  <div className="py-2 text-center border-t border-border/50 mt-1">
                    <button
                      onClick={categorizeAll}
                      disabled={categorizingAll}
                      className="text-sm text-accent-cyan hover:text-accent-cyan-hover transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {categorizingAll ? (
                        <><Loader2 className="h-3 w-3 animate-spin" /> categorizing {uncategorizedIds.length}...</>
                      ) : (
                        <>categorize {uncategorizedIds.length} unsorted</>
                      )}
                    </button>
                  </div>
                )}

                {/* Infinite scroll sentinel + loading indicator */}
                {chat.hasMoreConversations && (
                  <div
                    ref={loadMoreSentinelRef}
                    className="py-3 flex items-center justify-center"
                    aria-hidden={!chat.loadingMore}
                  >
                    {chat.loadingMore && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </ConversationPanelShell>

        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col min-h-0 rounded-lg border border-border bg-card overflow-hidden">
          {/* Machine selector bar — matches sidebar header height above `md`
              (`md:h-12` + `md:py-0` keep that row pixel-identical). Below it the
              row wraps instead: the target selector, the offline warning and the
              approval/power toggles cannot share a single 366px line. */}
          <div className="min-h-12 md:h-12 px-3 py-2 md:py-0 border-b border-border flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-2">
            {/* Mobile: the only entry point to conversation history and "new
                conversation", both of which live in the sheet at this width. */}
            <button
              onClick={() => setMobileConversationsOpen(true)}
              aria-label="conversations"
              className="md:hidden p-1 rounded hover:bg-accent transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSidebarOpen((prev) => !prev)}
                  aria-label={sidebarOpen ? 'hide hoot sidebar' : 'show hoot sidebar'}
                  className="hidden md:flex p-1 rounded hover:bg-accent transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  {sidebarOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeftOpen className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{sidebarOpen ? 'hide sidebar' : 'show sidebar'}</p>
              </TooltipContent>
            </Tooltip>
            <MachineSelector
              machines={machines.map((m) => ({
                id: m.machineId,
                name: m.machineId,
                online: m.online,
              }))}
              selectedMachineId={selectedMachineId}
              onSelect={(id) => {
                setSelectedMachineId(id);
                updateLastMachine(currentSiteId, id);
                const isSite = id === SITE_TARGET_ID;
                handleNewChat({ machineId: id, machineName: isSite ? 'All Machines' : id });
              }}
            />

            {!isSiteMode && selectedMachine && !selectedMachine.online && (
              <span className="text-xs text-yellow-500">
                machine is offline — tool calls will not be delivered
              </span>
            )}
            {isSiteMode && machines.length > 0 && machines.filter((m) => m.online).length === 0 && (
              <span className="text-xs text-yellow-500">
                no machines online — tool calls will not be delivered
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {currentSiteId && isSiteAdmin(currentSiteId) && (
                <HootApprovalToggle siteId={currentSiteId} />
              )}
              {!isSiteMode && selectedMachine && (
                <HootPowerToggle siteId={currentSiteId} machine={selectedMachine} />
              )}
            </div>
          </div>

          {/* Messages */}
          {showConversationNotFound ? (
            <ConversationNotFoundState onStartNew={() => handleNewChat()} />
          ) : (
            <ChatWindow
              messages={chat.messages}
              isLoading={chat.isLoading}
              hasApiKey={hasApiKey}
              onOpenSettings={() => setAccountSettingsOpen(true)}
              onToolApproval={(id, approved) => chat.addToolApprovalResponse({ id, approved })}
              onEditMessage={chat.editMessage}
              approvalTargetLabel={isSiteMode ? 'all machines' : selectedMachineId}
              toolCommands={chat.toolCommands}
              onCancelTool={handleCancelTool}
              cancelPendingCommandIds={cancelPendingCommandIds}
              turnStale={chat.turnStale}
            />
          )}

          {/* Error display */}
          {chat.error && !errorDismissed && (
            <div className="px-4 py-2 bg-red-950/30 border-t border-red-800/50">
              <div className="flex items-center gap-2 max-w-3xl mx-auto">
                <p className="text-xs text-red-400 flex-1">
                  {(() => {
                    const msg = chat.error?.message || 'Unknown error';
                    try {
                      const parsed = JSON.parse(msg);
                      return parsed.error || msg;
                    } catch {
                      return msg;
                    }
                  })()}
                </p>
                {/* Re-run the failed turn: regenerate() drops the interrupted
                    assistant message (and any stuck "executing…" tool card) and
                    streams a fresh response from the last user message. */}
                <button
                  onClick={() => { setErrorDismissed(true); void chat.regenerate(); }}
                  className="flex items-center gap-1 text-xs text-red-300 hover:text-red-200 transition-colors cursor-pointer flex-shrink-0"
                >
                  <RotateCw className="h-3 w-3" />
                  retry
                </button>
                <button
                  onClick={() => setErrorDismissed(true)}
                  aria-label="dismiss error"
                  className="text-red-400 hover:text-red-300 transition-colors cursor-pointer flex-shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          {!showConversationNotFound && (
            <ChatInput
              input={chat.input}
              isLoading={chat.isLoading}
              onInputChange={(e) => chat.setInput(e.target.value)}
              onSubmit={(e) => {
                e.preventDefault();
                chat.handleSend();
              }}
              onStop={chat.stop}
              pendingImages={chat.pendingImages}
              onPasteImage={chat.handlePasteImage}
              onRemoveImage={chat.removePendingImage}
            />
          )}
        </main>
      </div>

      {/* Dialogs */}
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={(open) => { setAccountSettingsOpen(open); if (!open) setSettingsInitialSection('profile'); }}
        initialSection={settingsInitialSection}
      />
    </div>
  );
}

/**
 * Surface for the conversation list.
 *
 * Above `md` it is the collapsible aside beside the chat. Below `md` there is no
 * room for a 256px column next to a usable chat pane, so the same children move
 * into a left-slide sheet — without it, conversation history and "new
 * conversation" are simply unreachable on a phone.
 *
 * Built straight on the `@radix-ui/react-dialog` primitives — the same building
 * blocks as `components/roost/RoostMobileSheet`, and deliberately not
 * `components/ui/dialog`, whose `DialogContent` is a centred modal that fights an
 * edge-anchored panel. Esc, overlay-click-to-close and the focus trap are
 * inherited from Radix.
 *
 * The branch is driven by a JS media query rather than `md:hidden`, and the two
 * branches are mutually exclusive, for two reasons: Radix portals the overlay +
 * content into document.body where a wrapper class no longer reaches them, and
 * the caller's `sidebarScrollRef` / `loadMoreSentinelRef` are single refs that
 * would end up pointing at whichever copy mounted last if both surfaces rendered.
 */
function ConversationPanelShell({
  isDesktop,
  sidebarOpen,
  mobileOpen,
  onMobileOpenChange,
  children,
}: {
  isDesktop: boolean;
  sidebarOpen: boolean;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  if (isDesktop) {
    return (
      <aside className={`bg-card flex-col hidden md:flex overflow-hidden transition-all duration-300 ease-in-out rounded-lg border border-border ${sidebarOpen ? 'w-64' : 'w-0 border-0'}`}>
        {children}
      </aside>
    );
  }

  return (
    <DialogPrimitive.Root open={mobileOpen} onOpenChange={onMobileOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-xs flex-col bg-card border-r border-border shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left">
          <div className="h-12 px-3 flex flex-shrink-0 items-center justify-between border-b border-border">
            <DialogPrimitive.Title className="text-sm font-medium text-foreground">
              conversations
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="close conversations"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ConversationNotFoundState({ onStartNew }: { onStartNew: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-4">
        <MessageSquare className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-2">
          conversation not found
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          this conversation doesn&apos;t exist or you don&apos;t have access to it
        </p>
        <button
          type="button"
          onClick={onStartNew}
          className="text-xs px-4 py-2 rounded-md bg-accent-cyan text-gray-900 font-medium hover:bg-accent-cyan/90 transition-colors cursor-pointer"
        >
          start new chat
        </button>
      </div>
    </div>
  );
}

function ConversationItem({
  conversation,
  isActive,
  onClick,
  onDelete,
  onRename,
}: {
  conversation: ChatConversation;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 bg-red-950/30 border-y border-red-800/30">
        <p className="text-xs text-red-400 flex-1 truncate">delete?</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
                setConfirming(false);
              }}
              aria-label={`confirm delete ${conversation.title}`}
              className="p-1 rounded hover:bg-red-900/50 transition-colors cursor-pointer"
            >
              <Check className="h-3.5 w-3.5 text-red-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>confirm delete</p>
          </TooltipContent>
        </Tooltip>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          aria-label={`cancel delete ${conversation.title}`}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 bg-accent/30 border-y border-border">
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRename(editValue);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          className="flex-1 text-sm bg-secondary rounded px-2 py-1 outline-none border border-border focus:border-accent-cyan min-w-0"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
            onClick={(e) => {
              e.stopPropagation();
              onRename(editValue);
              setEditing(false);
            }}
            aria-label={`save rename ${conversation.title}`}
            className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
          >
              <Check className="h-3.5 w-3.5 text-accent-cyan" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>save</p>
          </TooltipContent>
        </Tooltip>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(false);
          }}
          aria-label={`cancel rename ${conversation.title}`}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-active-conversation={isActive ? 'true' : undefined}
      className={`group flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors ${
        isActive ? 'bg-accent' : ''
      }`}
    >
      {/* The open-conversation control is a real <button> (keyboard- and
          screen-reader-accessible) with the rename/delete buttons as SIBLINGS,
          not nested inside it — nesting interactive controls is a serious axe
          violation (nested-interactive) and fails the hoot a11y gate. */}
      <button
        type="button"
        onClick={onClick}
        aria-current={isActive ? 'true' : undefined}
        className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan focus-visible:ring-inset"
      >
        {conversation.source === 'autonomous' ? (
          <Zap className="h-3.5 w-3.5 text-accent-cyan flex-shrink-0" />
        ) : (
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm text-foreground truncate">{conversation.title}</p>
            {conversation.source === 'autonomous' && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan font-medium flex-shrink-0">
                auto
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <span className="truncate">{conversation.targetType === 'site' ? 'all machines' : conversation.machineName || 'unknown machine'}</span>
            <span className="text-muted-foreground flex-shrink-0">· {timeAgo(conversation.updatedAt)}</span>
          </p>
        </div>
      </button>
      {/* Reveal-on-hover above `md` only. Touch devices never fire hover, so
          below the breakpoint (where these rows live in the mobile sheet) the
          rename/delete controls would be permanently invisible — still clickable,
          which is worse than hidden. The `md:` pair restores the desktop
          behaviour exactly. */}
      <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 flex items-center transition-all">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditValue(conversation.title);
            setEditing(true);
          }}
          aria-label={`rename ${conversation.title}`}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground transition-colors" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          aria-label={`delete ${conversation.title}`}
          className="p-1 rounded hover:bg-red-900/40 transition-colors cursor-pointer"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-red-400 transition-colors" />
        </button>
      </div>
    </div>
  );
}
