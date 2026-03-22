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
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  onSnapshot,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { type UIMessage } from 'ai';
import { SITE_TARGET_ID } from '@/app/cortex/components/MachineSelector';

export interface ChatConversation {
  id: string;
  title: string;
  siteId: string;
  targetType: 'machine' | 'site';
  targetMachineId: string | null;
  machineName: string | null;
  source?: 'user' | 'autonomous';
  autonomousSummary?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
            messages: messages.map((m) => ({
              role: m.role,
              content: m.parts
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join('') || '',
            })),
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
          const title = firstTextPart && 'text' in firstTextPart
            ? (firstTextPart as { text: string }).text.slice(0, 100)
            : 'New conversation';

          const isSiteMode = machineId === SITE_TARGET_ID;

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
              title,
              messages: serializedMessages,
              updatedAt: serverTimestamp(),
              ...(chat.messages.length <= 2 ? { createdAt: serverTimestamp() } : {}),
            },
            { merge: true }
          );
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
      limit(50)
    );

    // Autonomous chats for this site (no userId, source === 'autonomous')
    const autoQuery = siteId ? query(
      chatsRef,
      where('source', '==', 'autonomous'),
      where('siteId', '==', siteId),
      orderBy('updatedAt', 'desc'),
      limit(20)
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
        title: data.title || 'New conversation',
        siteId: data.siteId,
        targetType: data.targetType || 'machine',
        targetMachineId: data.targetMachineId || null,
        machineName: data.machineName || null,
        source: data.source || 'user',
        autonomousSummary: data.autonomousSummary || null,
        createdAt: data.createdAt?.toDate?.() || new Date(),
        updatedAt: data.updatedAt?.toDate?.() || new Date(),
      };
    }

    const unsubUser = onSnapshot(
      userQuery,
      (snapshot) => {
        userConvos = snapshot.docs.map(parseConvo).filter((c): c is ChatConversation => c !== null);
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

  const startNewChat = useCallback(() => {
    const newId = generateChatId();
    setChatId(newId);
    chat.setMessages([]);
    setInputValue('');

    // Add optimistic entry to sidebar, removing any previous empty "New conversation" entries
    const isSiteMode = machineIdRef.current === SITE_TARGET_ID;
    setConversations((prev) => [
      {
        id: newId,
        title: 'New conversation',
        siteId: siteIdRef.current,
        targetType: isSiteMode ? 'site' : 'machine',
        targetMachineId: isSiteMode ? null : machineIdRef.current,
        machineName: isSiteMode ? 'All Machines' : machineNameRef.current,
        source: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ...prev.filter((c) => c.title !== 'New conversation'),
    ]);
  }, [chat]);

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
      // Remove from local list immediately (handles both persisted and optimistic entries)
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));

      if (conversationId === chatId) {
        startNewChat();
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
    [chatId, startNewChat]
  );

  const handleSend = useCallback(() => {
    if (!inputValue.trim()) return;
    chat.sendMessage({ text: inputValue });
    setInputValue('');
  }, [inputValue, chat]);

  const isLoading = chat.status === 'streaming' || chat.status === 'submitted';

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

    // Conversation management
    chatId,
    conversations,
    loadingConversations,
    startNewChat,
    loadChat,
    deleteChat,
  };
}

function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
