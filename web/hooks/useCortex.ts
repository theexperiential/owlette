/**
 * Chat state management hook for the Owlette AI chat interface.
 *
 * Wraps the Vercel AI SDK v6 useChat hook with Owlette-specific logic:
 * - Machine/site targeting
 * - Chat persistence to Firestore
 * - Conversation history management
 */

'use client';

import { useChat as useAIChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  onSnapshot,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { type UIMessage, type FileUIPart } from 'ai';
import { SITE_TARGET_ID } from '@/app/cortex/components/MachineSelector';
import { uploadChatImage } from '@/lib/chatImageUtils';
import type { PendingImage } from '@/app/cortex/components/ChatInput';

export interface ChatConversation {
  id: string;
  title: string;
  siteId: string;
  targetType: 'machine' | 'site';
  targetMachineId: string | null;
  machineName: string | null;
  source?: 'user' | 'autonomous';
  autonomousSummary?: string | null;
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PAGE_SIZE = 20;

interface UseChatOptions {
  siteId: string;
  machineId: string;
  machineName: string;
}

export function useOwletteChat({ siteId, machineId, machineName }: UseChatOptions) {
  const { user } = useAuth();
  const [chatId, setChatId] = useState<string>(() => generateChatId());
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // Pagination state
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreUser, setHasMoreUser] = useState(false);
  const [hasMoreAuto, setHasMoreAuto] = useState(false);
  const lastUserDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const lastAutoDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Use refs so the transport closure always reads the latest values
  const siteIdRef = useRef(siteId);
  const machineIdRef = useRef(machineId);
  const machineNameRef = useRef(machineName);
  const chatIdRef = useRef(chatId);
  siteIdRef.current = siteId;
  machineIdRef.current = machineId;
  machineNameRef.current = machineName;
  chatIdRef.current = chatId;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/cortex',
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages: messages.map((m) => {
              const hasFiles = m.parts.some((p) => p.type === 'file');

              if (!hasFiles) {
                // Text-only message — send as plain string for backwards compat
                return {
                  role: m.role,
                  content: m.parts
                    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                    .map((p) => p.text)
                    .join('') || '',
                };
              }

              // Multimodal message — send as AI SDK content block array
              const content: Array<Record<string, unknown>> = [];
              for (const p of m.parts) {
                if (p.type === 'text') {
                  content.push({ type: 'text', text: (p as { text: string }).text });
                } else if (p.type === 'file') {
                  const fp = p as FileUIPart;
                  if (fp.mediaType?.startsWith('image/')) {
                    // AI SDK ImagePart format: { type: 'image', image: url, mediaType }
                    content.push({
                      type: 'image',
                      image: fp.url,
                      mediaType: fp.mediaType,
                    });
                  }
                }
              }
              return { role: m.role, content };
            }),
            siteId: siteIdRef.current,
            machineId: machineIdRef.current,
            machineName: machineNameRef.current,
            chatId: chatIdRef.current,
          },
        }),
      }),
    []
  );

  const chat = useAIChat({
    id: chatId,
    transport,
    onFinish: async () => {
      // Persist conversation metadata + messages after assistant response
      if (user && db) {
        try {
          const chatRef = doc(db, 'chats', chatId);
          const firstUserMsg = chat.messages.find((m) => m.role === 'user');
          const firstTextPart = firstUserMsg?.parts?.find((p) => p.type === 'text');
          const userMessage = firstTextPart && 'text' in firstTextPart
            ? (firstTextPart as { text: string }).text
            : '';

          const isSiteMode = machineId === SITE_TARGET_ID;
          const isNewConversation = chat.messages.length <= 2;

          // For new conversations, use truncated message as placeholder until LLM generates title
          const title = isNewConversation
            ? (userMessage.slice(0, 100) || 'new conversation')
            : undefined; // Don't overwrite LLM-generated title on subsequent messages

          // Serialize messages for Firestore storage
          const serializedMessages = chat.messages.map((m) => ({
            id: m.id,
            role: m.role,
            parts: m.parts.map((p) => JSON.parse(JSON.stringify(p))),
          }));

          await setDoc(
            chatRef,
            {
              userId: user.uid,
              siteId,
              targetType: isSiteMode ? 'site' : 'machine',
              targetMachineId: isSiteMode ? null : machineId,
              machineName: isSiteMode ? 'All Machines' : machineName,
              ...(title ? { title } : {}),
              messages: serializedMessages,
              updatedAt: serverTimestamp(),
              ...(isNewConversation ? { createdAt: serverTimestamp() } : {}),
            },
            { merge: true }
          );

          // Auto-title + categorize new conversations (fire-and-forget)
          if (isNewConversation && userMessage) {
            fetch('/api/cortex/categorize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chatId, message: userMessage, siteId }),
            }).catch(() => { /* silent — best-effort */ });
          }
        } catch (error) {
          console.error('Failed to persist chat:', error);
        }
      }
    },
  });

  // Load conversation history (user chats + autonomous chats for the site)
  useEffect(() => {
    if (!user || !db) {
      setLoadingConversations(false);
      return;
    }

    const chatsRef = collection(db, 'chats');

    // User's own chats
    const userQuery = query(
      chatsRef,
      where('userId', '==', user.uid),
      orderBy('updatedAt', 'desc'),
      limit(PAGE_SIZE)
    );

    // Autonomous chats for this site (no userId, source === 'autonomous')
    const autoQuery = siteId ? query(
      chatsRef,
      where('source', '==', 'autonomous'),
      where('siteId', '==', siteId),
      orderBy('updatedAt', 'desc'),
      limit(PAGE_SIZE)
    ) : null;

    let userConvos: ChatConversation[] = [];
    let autoConvos: ChatConversation[] = [];
    let userLoaded = false;
    let autoLoaded = !autoQuery; // If no autoQuery, mark as loaded

    function mergeAndSet() {
      if (!userLoaded || !autoLoaded) return;
      // Merge, deduplicate by id, sort by updatedAt desc
      const all = [...userConvos, ...autoConvos];
      const seen = new Set<string>();
      const deduped = all.filter(c => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      deduped.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      setConversations(deduped);
      setLoadingConversations(false);
    }

    function parseConvo(docSnap: import('firebase/firestore').DocumentSnapshot): ChatConversation | null {
      const data = docSnap.data();
      if (!data) return null;
      if (data.siteId !== siteId) return null;
      return {
        id: docSnap.id,
        title: data.title || 'new conversation',
        siteId: data.siteId,
        targetType: data.targetType || 'machine',
        targetMachineId: data.targetMachineId || null,
        machineName: data.machineName || null,
        source: data.source || 'user',
        autonomousSummary: data.autonomousSummary || null,
        category: data.category || undefined,
        createdAt: data.createdAt?.toDate?.() || new Date(),
        updatedAt: data.updatedAt?.toDate?.() || new Date(),
      };
    }

    const unsubUser = onSnapshot(
      userQuery,
      (snapshot) => {
        userConvos = snapshot.docs.map(parseConvo).filter((c): c is ChatConversation => c !== null);
        // Track cursor and hasMore for pagination
        const docs = snapshot.docs;
        lastUserDocRef.current = docs.length > 0 ? docs[docs.length - 1] : null;
        setHasMoreUser(docs.length === PAGE_SIZE);
        userLoaded = true;
        mergeAndSet();
      },
      (error) => {
        console.error('Failed to load user conversations:', error);
        userLoaded = true;
        mergeAndSet();
      }
    );

    let unsubAuto: (() => void) | undefined;
    if (autoQuery) {
      unsubAuto = onSnapshot(
        autoQuery,
        (snapshot) => {
          autoConvos = snapshot.docs.map(parseConvo).filter((c): c is ChatConversation => c !== null);
          const docs = snapshot.docs;
          lastAutoDocRef.current = docs.length > 0 ? docs[docs.length - 1] : null;
          setHasMoreAuto(docs.length === PAGE_SIZE);
          autoLoaded = true;
          mergeAndSet();
        },
        (error) => {
          console.error('Failed to load autonomous conversations:', error);
          autoLoaded = true;
          mergeAndSet();
        }
      );
    }

    return () => {
      unsubUser();
      unsubAuto?.();
    };
  }, [user, siteId]);

  const startNewChat = useCallback((overrides?: { machineId?: string; machineName?: string }) => {
    const newId = generateChatId();
    setChatId(newId);
    chat.setMessages([]);
    setInputValue('');
    setPendingImages([]);

    // Use overrides if provided (handles race condition when machine selector changes in same handler)
    const effectiveMachineId = overrides?.machineId ?? machineIdRef.current;
    const effectiveMachineName = overrides?.machineName ?? machineNameRef.current;
    const isSiteMode = effectiveMachineId === SITE_TARGET_ID;

    // Add optimistic entry to sidebar, removing any previous empty "new conversation" entries
    setConversations((prev) => [
      {
        id: newId,
        title: 'new conversation',
        siteId: siteIdRef.current,
        targetType: isSiteMode ? 'site' : 'machine',
        targetMachineId: isSiteMode ? null : effectiveMachineId,
        machineName: isSiteMode ? 'All Machines' : effectiveMachineName,
        source: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ...prev.filter((c) => c.title !== 'new conversation'),
    ]);
  }, [chat]);

  const loadMoreConversations = useCallback(async () => {
    if (loadingMore || !user || !db) return;
    if (!hasMoreUser && !hasMoreAuto) return;

    setLoadingMore(true);
    try {
      const chatsRef = collection(db, 'chats');
      const newConvos: ChatConversation[] = [];

      // Load more user conversations
      if (hasMoreUser && lastUserDocRef.current) {
        const moreUserQuery = query(
          chatsRef,
          where('userId', '==', user.uid),
          orderBy('updatedAt', 'desc'),
          startAfter(lastUserDocRef.current),
          limit(PAGE_SIZE)
        );
        const snapshot = await getDocs(moreUserQuery);
        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data && data.siteId === siteId) {
            newConvos.push({
              id: docSnap.id,
              title: data.title || 'new conversation',
              siteId: data.siteId,
              targetType: data.targetType || 'machine',
              targetMachineId: data.targetMachineId || null,
              machineName: data.machineName || null,
              source: data.source || 'user',
              autonomousSummary: data.autonomousSummary || null,
              category: data.category || undefined,
              createdAt: data.createdAt?.toDate?.() || new Date(),
              updatedAt: data.updatedAt?.toDate?.() || new Date(),
            });
          }
        }
        lastUserDocRef.current = snapshot.docs.length > 0
          ? snapshot.docs[snapshot.docs.length - 1]
          : null;
        setHasMoreUser(snapshot.docs.length === PAGE_SIZE);
      }

      // Load more autonomous conversations
      if (hasMoreAuto && lastAutoDocRef.current && siteId) {
        const moreAutoQuery = query(
          chatsRef,
          where('source', '==', 'autonomous'),
          where('siteId', '==', siteId),
          orderBy('updatedAt', 'desc'),
          startAfter(lastAutoDocRef.current),
          limit(PAGE_SIZE)
        );
        const snapshot = await getDocs(moreAutoQuery);
        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data) {
            newConvos.push({
              id: docSnap.id,
              title: data.title || 'new conversation',
              siteId: data.siteId,
              targetType: data.targetType || 'machine',
              targetMachineId: data.targetMachineId || null,
              machineName: data.machineName || null,
              source: data.source || 'user',
              autonomousSummary: data.autonomousSummary || null,
              category: data.category || undefined,
              createdAt: data.createdAt?.toDate?.() || new Date(),
              updatedAt: data.updatedAt?.toDate?.() || new Date(),
            });
          }
        }
        lastAutoDocRef.current = snapshot.docs.length > 0
          ? snapshot.docs[snapshot.docs.length - 1]
          : null;
        setHasMoreAuto(snapshot.docs.length === PAGE_SIZE);
      }

      // Append and deduplicate
      if (newConvos.length > 0) {
        setConversations((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          const unique = newConvos.filter((c) => !seen.has(c.id));
          const merged = [...prev, ...unique];
          merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          return merged;
        });
      }
    } catch (error) {
      console.error('Failed to load more conversations:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, user, siteId, hasMoreUser, hasMoreAuto]);

  const hasMoreConversations = hasMoreUser || hasMoreAuto;

  const loadChat = useCallback(
    async (conversationId: string) => {
      setChatId(conversationId);
      setInputValue('');

      // Fetch persisted messages from Firestore
      if (db) {
        try {
          const chatDoc = await getDoc(doc(db, 'chats', conversationId));
          const data = chatDoc.data();
          if (data?.messages && Array.isArray(data.messages)) {
            chat.setMessages(data.messages as UIMessage[]);
          } else {
            chat.setMessages([]);
          }
        } catch (error) {
          console.error('Failed to load chat messages:', error);
          chat.setMessages([]);
        }
      }
    },
    [chat]
  );

  const deleteChat = useCallback(
    async (conversationId: string) => {
      // Check if this is an unpersisted "new conversation" (no messages sent yet)
      const isEmptyNew = conversations.find(
        (c) => c.id === conversationId && c.title === 'new conversation'
      );

      // Remove from local list immediately (handles both persisted and optimistic entries)
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));

      if (conversationId === chatId) {
        if (isEmptyNew) {
          // Deleted an empty "new conversation" — reset state without creating another one
          const newId = generateChatId();
          setChatId(newId);
          chat.setMessages([]);
          setInputValue('');
        } else {
          startNewChat();
        }
      }

      // Try to delete from Firestore (will silently succeed even if doc doesn't exist)
      if (db) {
        try {
          await deleteDoc(doc(db, 'chats', conversationId));
        } catch (error) {
          console.error('Failed to delete chat:', error);
        }
      }
    },
    [chatId, conversations, startNewChat, chat]
  );

  const renameChat = useCallback(
    async (conversationId: string, newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!trimmed) return;

      // Update locally immediately
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title: trimmed } : c))
      );

      // Persist to Firestore
      if (db) {
        try {
          await setDoc(doc(db, 'chats', conversationId), { title: trimmed }, { merge: true });
        } catch (error) {
          console.error('Failed to rename chat:', error);
        }
      }
    },
    []
  );

  const handleSend = useCallback(() => {
    const readyImages = pendingImages.filter((i) => !i.uploading);
    if (!inputValue.trim() && readyImages.length === 0) return;

    const files: FileUIPart[] = readyImages.map((i) => ({
      type: 'file' as const,
      mediaType: i.mediaType,
      url: i.url,
    }));

    if (files.length > 0) {
      chat.sendMessage({ text: inputValue || '', files });
    } else {
      chat.sendMessage({ text: inputValue });
    }
    setInputValue('');
    setPendingImages([]);
  }, [inputValue, pendingImages, chat]);

  const handlePasteImage = useCallback(
    async (blob: Blob) => {
      if (!user) return;

      // Create a local preview URL immediately
      const previewUrl = URL.createObjectURL(blob);
      const placeholderIndex = pendingImages.length;

      setPendingImages((prev) => [
        ...prev,
        { url: '', mediaType: 'image/jpeg', uploading: true, previewUrl },
      ]);

      try {
        const { url, mediaType } = await uploadChatImage(user.uid, chatId, blob);
        setPendingImages((prev) =>
          prev.map((img, i) =>
            i === placeholderIndex
              ? { url, mediaType, uploading: false, previewUrl }
              : img,
          ),
        );
      } catch (error) {
        console.error('Failed to upload chat image:', error);
        // Remove the failed upload
        setPendingImages((prev) => prev.filter((_, i) => i !== placeholderIndex));
        URL.revokeObjectURL(previewUrl);
      }
    },
    [user, chatId, pendingImages.length],
  );

  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const isLoading = chat.status === 'streaming' || chat.status === 'submitted';

  // Compute displayed conversations (filtered by search if active)
  const displayedConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const lower = searchQuery.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(lower));
  }, [conversations, searchQuery]);

  return {
    // Messages
    messages: chat.messages,
    isLoading,
    error: chat.error,
    setMessages: chat.setMessages,
    stop: chat.stop,
    status: chat.status,

    // Input management
    input: inputValue,
    setInput: setInputValue,
    handleSend,

    // Image management
    pendingImages,
    handlePasteImage,
    removePendingImage,

    // Conversation management
    chatId,
    conversations: displayedConversations,
    loadingConversations,
    startNewChat,
    loadChat,
    deleteChat,
    renameChat,

    // Pagination
    hasMoreConversations,
    loadingMore,
    loadMoreConversations,

    // Search
    searchQuery,
    setSearchQuery,
  };
}

function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
