'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useOwletteChat, type ChatConversation } from '@/hooks/useCortex';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { Button } from '@/components/ui/button';
import { Plus, MessageSquare, Trash2, Brain, KeyRound, Check, X, Zap, Search, Loader2, Pencil, ChevronRight, ChevronsDownUp, ChevronsUpDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ChatWindow } from './components/ChatWindow';
import { ChatInput } from './components/ChatInput';
import { MachineSelector, SITE_TARGET_ID } from './components/MachineSelector';

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

  // Sort groups: most conversations first, "General" always last
  return Object.entries(groups)
    .sort(([a, aConvos], [b, bConvos]) => {
      if (a === 'General') return 1;
      if (b === 'General') return -1;
      return bConvos.length - aConvos.length;
    })
    .map(([label, convos]) => ({ label, conversations: convos }));
}

export default function CortexPage() {
  const router = useRouter();
  const { user, userSites, isAdmin, loading: authLoading, lastSiteId, lastMachineIds, updateLastSite, updateLastMachine } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isAdmin);

  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [selectedMachineId, setSelectedMachineId] = useState<string>(SITE_TARGET_ID);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'profile' | 'cortex'>('profile');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [categorizingAll, setCategorizingAll] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  const chat = useOwletteChat({
    siteId: currentSiteId,
    machineId: selectedMachineId,
    machineName: isSiteMode ? 'All Machines' : selectedMachineId,
  });

  // Reset error dismissed state when a new error arrives
  useEffect(() => {
    if (chat.error) setErrorDismissed(false);
  }, [chat.error]);

  const sidebarScrollRef = useRef<HTMLDivElement>(null);

  const handleNewChat = useCallback((overrides?: { machineId?: string; machineName?: string }) => {
    chat.startNewChat(overrides);
    sidebarScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [chat]);

  const uncategorizedIds = chat.conversations.filter((c) => !c.category).map((c) => c.id);

  const categorizeAll = async () => {
    if (categorizingAll || uncategorizedIds.length === 0) return;
    setCategorizingAll(true);
    try {
      await fetch('/api/cortex/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatIds: uncategorizedIds, siteId: currentSiteId }),
      });
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
      router.push('/login');
    }
  }, [user, authLoading, router]);

  if (authLoading || sitesLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">loading...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="h-screen flex flex-col bg-background">
      <PageHeader
        currentPage="cortex"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => {}}
        onAccountSettings={() => setAccountSettingsOpen(true)}
      />

      <div className="flex-1 flex min-h-0 relative">

        {/* No API key overlay */}
        {hasApiKey === false && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="text-center max-w-md px-4">
              <Brain className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">cortex</h3>
              <p className="text-sm text-muted-foreground mb-6">
                debug, diagnose, and manage your remote machines.
              </p>
              <div className="rounded-lg border border-border bg-secondary p-5">
                <KeyRound className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground mb-3">
                  cortex requires an LLM API key. add your anthropic or openai key in account settings.
                </p>
                <button
                  onClick={() => { setSettingsInitialSection('cortex'); setAccountSettingsOpen(true); }}
                  className="text-xs px-4 py-2 rounded-md bg-accent-cyan text-gray-900 font-medium hover:bg-accent-cyan/90 transition-colors cursor-pointer"
                >
                  open account settings
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Sidebar — Conversation List */}
        <aside className={`bg-background flex-col hidden md:flex overflow-hidden transition-all duration-300 ease-in-out ${sidebarOpen ? 'w-64' : 'w-0'}`}>
          <div className="w-64 min-w-64 h-12 px-2 border-b border-border bg-card flex items-center gap-1">
            {searchOpen ? (
              /* Search mode: compact new chat + expanded input */
              <>
                <Button
                  onClick={() => handleNewChat()}
                  variant="ghost"
                  size="icon"
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
                  <Button
                    onClick={() => {
                      const groups = groupConversationsByCategory(chat.conversations);
                      const allLabels = groups.map((g) => g.label);
                      const allCollapsed = allLabels.every((l) => collapsedGroups.has(l));
                      setCollapsedGroups(allCollapsed ? new Set() : new Set(allLabels));
                    }}
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                    title={collapsedGroups.size > 0 ? 'expand all' : 'collapse all'}
                  >
                    {collapsedGroups.size > 0 ? (
                      <ChevronsUpDown className="h-4 w-4" />
                    ) : (
                      <ChevronsDownUp className="h-4 w-4" />
                    )}
                  </Button>
                )}
                <Button
                  onClick={() => setSearchOpen(true)}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                >
                  <Search className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>

          <div ref={sidebarScrollRef} className="w-64 min-w-64 flex-1 overflow-y-auto border-r border-border">
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
                    onClick={() => chat.loadChat(convo.id)}
                    onDelete={() => chat.deleteChat(convo.id)}
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
                      onClick={() => chat.loadChat(convo.id)}
                      onDelete={() => chat.deleteChat(convo.id)}
                      onRename={(title) => chat.renameChat(convo.id, title)}
                    />
                  ))}
                {groupConversationsByCategory(
                  chat.conversations.filter((c) => c.title !== 'new conversation')
                ).map((group) => {
                  const isCollapsed = collapsedGroups.has(group.label);
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
                        <ChevronRight className={`h-3 w-3 text-muted-foreground/50 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                        <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                          {group.label}
                        </span>
                        <span className="text-xs text-muted-foreground/40 ml-auto">
                          {group.conversations.length}
                        </span>
                      </button>
                      {!isCollapsed && group.conversations.map((convo) => (
                        <ConversationItem
                          key={convo.id}
                          conversation={convo}
                          isActive={convo.id === chat.chatId}
                          onClick={() => chat.loadChat(convo.id)}
                          onDelete={() => chat.deleteChat(convo.id)}
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
                      className="text-[10px] text-accent-cyan/70 hover:text-accent-cyan transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {categorizingAll ? (
                        <><Loader2 className="h-3 w-3 animate-spin" /> categorizing {uncategorizedIds.length}...</>
                      ) : (
                        <>categorize {uncategorizedIds.length} unsorted</>
                      )}
                    </button>
                  </div>
                )}

                {/* Load more */}
                {chat.hasMoreConversations && (
                  <div className="py-2 text-center">
                    <button
                      onClick={chat.loadMoreConversations}
                      disabled={chat.loadingMore}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {chat.loadingMore ? (
                        <><Loader2 className="h-3 w-3 animate-spin" /> loading...</>
                      ) : (
                        'load more'
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col min-h-0">
          {/* Machine selector bar — matches sidebar header height */}
          <div className="h-12 px-3 border-b border-border bg-card flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((prev) => !prev)}
              className="hidden md:flex p-1 rounded hover:bg-accent transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
              title={sidebarOpen ? 'hide sidebar' : 'show sidebar'}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </button>
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
          </div>

          {/* Messages */}
          <ChatWindow
            messages={chat.messages}
            isLoading={chat.isLoading}
            hasApiKey={hasApiKey}
            onOpenSettings={() => setAccountSettingsOpen(true)}
          />

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
                <button
                  onClick={() => setErrorDismissed(true)}
                  className="text-red-400 hover:text-red-300 transition-colors cursor-pointer flex-shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Input */}
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
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
            setConfirming(false);
          }}
          className="p-1 rounded hover:bg-red-900/50 transition-colors cursor-pointer"
        >
          <Check className="h-3.5 w-3.5 text-red-400" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          className="p-1 rounded hover:bg-secondary transition-colors cursor-pointer"
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
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRename(editValue);
            setEditing(false);
          }}
          className="p-1 rounded hover:bg-secondary transition-colors cursor-pointer"
        >
          <Check className="h-3.5 w-3.5 text-accent-cyan" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(false);
          }}
          className="p-1 rounded hover:bg-secondary transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors ${
        isActive ? 'bg-accent' : ''
      }`}
      onClick={onClick}
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
          <span className="opacity-50 flex-shrink-0">· {timeAgo(conversation.updatedAt)}</span>
        </p>
      </div>
      <div className="opacity-0 group-hover:opacity-100 flex items-center transition-all">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditValue(conversation.title);
            setEditing(true);
          }}
          className="p-1 rounded hover:bg-secondary transition-colors cursor-pointer"
        >
          <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground transition-colors" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          className="p-1 rounded hover:bg-red-900/40 transition-colors cursor-pointer"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-red-400 transition-colors" />
        </button>
      </div>
    </div>
  );
}
