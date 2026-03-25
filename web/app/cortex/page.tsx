'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useOwletteChat, type ChatConversation } from '@/hooks/useCortex';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { Button } from '@/components/ui/button';
import { Plus, MessageSquare, Trash2, Brain, KeyRound, Check, X, Zap } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ChatWindow } from './components/ChatWindow';
import { ChatInput } from './components/ChatInput';
import { MachineSelector, SITE_TARGET_ID } from './components/MachineSelector';

export default function CortexPage() {
  const router = useRouter();
  const { user, userSites, isAdmin, loading: authLoading, lastSiteId, lastMachineIds, updateLastSite, updateLastMachine } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isAdmin);

  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [selectedMachineId, setSelectedMachineId] = useState<string>(SITE_TARGET_ID);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'profile' | 'cortex'>('profile');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

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
        <aside className="w-64 border-r border-border bg-background flex flex-col hidden md:flex">
          <div className="px-3 py-2 border-b border-border flex items-center">
            <Button
              onClick={chat.startNewChat}
              variant="outline"
              size="sm"
              className="w-full border-border text-foreground hover:bg-accent h-9"
            >
              <Plus className="h-4 w-4 mr-2" />
              new conversation
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {chat.conversations.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                no conversations yet
              </div>
            ) : (
              <div className="py-1">
                {chat.conversations.map((convo) => (
                  <ConversationItem
                    key={convo.id}
                    conversation={convo}
                    isActive={convo.id === chat.chatId}
                    onClick={() => chat.loadChat(convo.id)}
                    onDelete={() => chat.deleteChat(convo.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col min-h-0">
          {/* Machine selector bar — matches sidebar header height */}
          <div className="px-3 py-2 border-b border-border flex items-center gap-3">
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
                chat.startNewChat();
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
          {chat.error && (
            <div className="px-4 py-2 bg-red-950/30 border-t border-red-800/50">
              <p className="text-xs text-red-400 max-w-3xl mx-auto">
                {(() => {
                  const msg = chat.error?.message || 'Unknown error';
                  // API errors come as JSON strings like '{"error":"..."}'
                  try {
                    const parsed = JSON.parse(msg);
                    return parsed.error || msg;
                  } catch {
                    return msg;
                  }
                })()}
              </p>
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
}: {
  conversation: ChatConversation;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

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
          <p className="text-xs text-foreground truncate">{conversation.title}</p>
          {conversation.source === 'autonomous' && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan font-medium flex-shrink-0">
              auto
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {conversation.targetType === 'site' ? 'all machines' : conversation.machineName || 'unknown machine'}
        </p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(true);
        }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-900/40 transition-all cursor-pointer"
      >
        <Trash2 className="h-3 w-3 text-muted-foreground group-hover:text-red-400 transition-colors" />
      </button>
    </div>
  );
}
