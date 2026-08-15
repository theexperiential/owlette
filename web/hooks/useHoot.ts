/**
 * Chat state management hook for the Owlette AI chat interface.
 *
 * Wraps the Vercel AI SDK v6 useChat hook with Owlette-specific logic:
 * - Machine/site targeting
 * - Conversation history management
 * - Async-turn recovery (hoot-async-turns): live subscription to the
 *   durable turn doc `chats/{chatId}/stream/current`, reattach after a dead
 *   HTTP stream / page reload, supersede-on-send, tool cancellation, and
 *   stale-turn detection. Final chat persistence is server-owned (the turn
 *   runner in web/lib/hoot/turnRunner.server.ts is the persist authority).
 */

'use client';

import { useChat as useAIChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
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
  onSnapshot,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { type UIMessage, type FileUIPart } from 'ai';
import { SITE_TARGET_ID } from '@/app/hoot/components/MachineSelector';
import { uploadChatImage } from '@/lib/chatImageUtils';
import type { PendingImage } from '@/app/hoot/components/ChatInput';

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

const PAGE_SIZE = 40;

/**
 * A single dispatched-command entry mirrored from the live turn doc
 * (`chats/{chatId}/stream/current.toolCommands`), which is now nested as
 * `toolCallId → machineId → { commandId }`. Nesting per-machine lets a
 * site-wide fan-out record EVERY machine's command (the old flat shape was
 * last-write-wins — only the final machine's command survived). Shape must stay
 * in sync with `turnStore.server.ts` (server-only module — not importable here).
 */
export interface TurnToolCommand {
  commandId: string;
}

/** `toolCallId → machineId → { commandId }` — the per-chat cancel index. */
export type TurnToolCommands = Record<string, Record<string, TurnToolCommand>>;

// Mirrors TURN_STALE_MS in web/lib/hoot/turnStore.server.ts: a `running`
// stream doc whose heartbeat is older than this is a dead runner (killed by a
// deploy) — surfaced to the UI as `turnStale`.
const TURN_STALE_MS = 45_000;

// `updatedAt` going stale doesn't emit a Firestore snapshot by itself, so
// staleness is re-checked on an interval while a running doc is held.
const TURN_STALE_RECHECK_MS = 15_000;

// Delay before resubscribing after a stream-doc listener error (onSnapshot
// terminates the listener when its error callback fires). permission-denied
// is expected for brand-new chats — see the subscription effect.
const STREAM_RESUBSCRIBE_MS = 15_000;

interface UseChatOptions {
  siteId: string;
  machineId: string;
  machineName: string;
  onChatPersisted?: (chatId: string) => void;
}

export type ChatLoadError = 'not_found';

export function useOwletteChat({ siteId, machineId, machineName, onChatPersisted }: UseChatOptions) {
  const { user } = useAuth();
  const [chatId, setChatId] = useState<string>(() => generateChatId());
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [chatLoadError, setChatLoadError] = useState<ChatLoadError | null>(null);
  const loadChatRequestRef = useRef(0);
  const isMountedRef = useRef(true);
  // The current unpersisted "new conversation" row. Held in a ref so a Firestore
  // snapshot refire (which rebuilds `conversations` from persisted docs) doesn't
  // erase the optimistic entry before the first message is saved. Cleared once
  // its doc shows up in a snapshot, or when it's discarded/deleted.
  const draftConvoRef = useRef<ChatConversation | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      loadChatRequestRef.current += 1;
    };
  }, []);

  // Pagination state
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreUser, setHasMoreUser] = useState(false);
  const [hasMoreAuto, setHasMoreAuto] = useState(false);
  const lastUserDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const lastAutoDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Async turn state, mirrored from `chats/{chatId}/stream/current` (the
  // durable record of an in-flight turn, written by the server-side runner).
  const [toolCommands, setToolCommands] = useState<TurnToolCommands>({});
  const [turnStale, setTurnStale] = useState(false);
  // Bumped to resubscribe after a stream-doc listener error (Firestore kills
  // the listener once its error callback fires).
  const [streamSubAttempt, setStreamSubAttempt] = useState(0);

  // Use refs so the transport closure always reads the latest values
  const siteIdRef = useRef(siteId);
  const machineIdRef = useRef(machineId);
  const machineNameRef = useRef(machineName);
  const chatIdRef = useRef(chatId);
  const onChatPersistedRef = useRef(onChatPersisted);
  siteIdRef.current = siteId;
  machineIdRef.current = machineId;
  machineNameRef.current = machineName;
  chatIdRef.current = chatId;
  onChatPersistedRef.current = onChatPersisted;

  // Live "the stream doc says a turn is running" flag — read inside the
  // transport closure to decide supersede (React state would be stale there).
  const streamRunningRef = useRef(false);
  // Latest toolCommands map — cancelTool reads a tool call's per-machine
  // commandIds from it (site-wide chats fan a single call out to every machine).
  const toolCommandsRef = useRef<TurnToolCommands>({});
  // One-shot supersede flag: set when a send is issued while our own HTTP
  // stream is live (or by the 409 turn_active auto-retry); consumed once per
  // request build in prepareSendMessagesRequest.
  const forceSupersedeRef = useRef(false);
  // Loop guard for the automatic 409 turn_active retry — re-armed on the next
  // completed turn (onFinish).
  const turnActiveRetriedRef = useRef(false);
  // Id of the turn the stream doc currently reports as `running` (null when
  // idle). Read by stop() to POST /api/hoot/stop for a real server cancel.
  const currentTurnIdRef = useRef<string | null>(null);
  // One-shot: set when the user presses stop, so the reattach branch of the
  // stream subscription does NOT resurrect the in-progress assistant message
  // in the window between pressing stop and the doc flipping to `cancelled`.
  // Cleared once the stream doc reaches a terminal status (or is absent).
  const userStoppedRef = useRef(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/hoot',
        // Send the full UIMessages (text + file + tool/approval parts). The
        // server reconstructs ModelMessages via `convertToModelMessages`, which
        // is what lets a tier-3 approval round-trip carry the pending tool call
        // and the approve/deny decision back so streamText can resume.
        prepareSendMessagesRequest: ({ messages }) => {
          // Supersede when this send races an in-flight turn: either our own
          // HTTP stream was live at send time (handleSend/editMessage set the
          // one-shot flag, as does the 409 turn_active auto-retry) or the
          // durable stream doc says a turn is running (reattached client with
          // no local stream). The one-shot flag is consumed per request so an
          // automatic approval re-send doesn't inherit it.
          const supersede = forceSupersedeRef.current || streamRunningRef.current;
          forceSupersedeRef.current = false;
          return {
            body: {
              messages,
              siteId: siteIdRef.current,
              machineId: machineIdRef.current,
              machineName: machineNameRef.current,
              chatId: chatIdRef.current,
              ...(supersede ? { supersede: true } : {}),
            },
          };
        },
      }),
    []
  );

  const chat = useAIChat({
    id: chatId,
    transport,
    // Once the user has answered every pending tier-3 approval on the last
    // assistant message, automatically re-send so the SDK resumes (executes
    // approved tools, feeds denials back to the model).
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      // The server-side turn runner is the persist authority: it writes the
      // final messages to `chats/{chatId}` and triggers categorize for new
      // conversations (web/lib/hoot/turnRunner.server.ts) — persisting here
      // would race it (and used to persist even aborted turns). The client
      // only fires the URL-replace callback once the turn completes.
      turnActiveRetriedRef.current = false; // turn completed — re-arm the 409 auto-retry
      onChatPersistedRef.current?.(chatIdRef.current);
    },
  });

  // Ref mirror of the chat object so Firestore snapshot callbacks (async,
  // outside render) can read the live status and call setMessages.
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // Auto-retry once when a send lost the turn-lock race: the server returns
  // 409 `{code:'turn_active'}` while another fresh turn holds the lock, and
  // DefaultChatTransport surfaces the response body as the error message.
  // Force supersede and re-send. The ref guard prevents retry loops (it
  // re-arms on the next completed turn in onFinish); with supersede forced a
  // second turn_active is impossible, so one retry is sufficient.
  useEffect(() => {
    if (chat.status !== 'error' || !chat.error) return;
    // The 409 body is `{error, code:'turn_active'}`, which DefaultChatTransport
    // surfaces as `Error(responseText)`. Prefer a structural check on the parsed
    // `code`; fall back to the substring heuristic for any non-JSON body (or a
    // body whose code lives elsewhere) so the match is a superset of before.
    const rawMessage = String(chat.error.message ?? '');
    let isTurnActive: boolean;
    try {
      isTurnActive = (JSON.parse(rawMessage) as { code?: string }).code === 'turn_active';
    } catch {
      isTurnActive = false;
    }
    if (!isTurnActive) isTurnActive = rawMessage.includes('turn_active');
    if (!isTurnActive) return;
    if (turnActiveRetriedRef.current) return;
    turnActiveRetriedRef.current = true;
    forceSupersedeRef.current = true;
    chatRef.current.regenerate().catch((error) => {
      console.error('Failed to retry superseding send:', error);
    });
  }, [chat.status, chat.error]);

  // Live turn subscription — `chats/{chatId}/stream/current` is the durable
  // record of an in-flight turn, written by the server-side runner. It powers:
  //   - `toolCommands`: cancel targets for running tool calls,
  //   - reattach: rendering a turn we have no HTTP stream for (page reload
  //     mid-turn, or the stream died at a proxy),
  //   - `turnStale`: running doc with a dead heartbeat (runner killed).
  useEffect(() => {
    // Reset per-chat turn state before (re)subscribing.
    streamRunningRef.current = false;
    currentTurnIdRef.current = null;
    userStoppedRef.current = false;
    toolCommandsRef.current = {};
    setToolCommands({});
    setTurnStale(false);

    if (!user || !db) return;

    const streamDocRef = doc(db, 'chats', chatId, 'stream', 'current');
    // `updatedAt` (ms) of the currently running doc — staleness input.
    let runningUpdatedAtMs: number | null = null;
    // True once we've merged Firestore snapshots for a turn we have no HTTP
    // stream for; the next terminal status then lands the persisted history.
    let reattached = false;
    // Id of the in-progress assistant message we merged from snapshots —
    // used to detect whether the runner's final persist has landed yet.
    let mergedMessageId: string | null = null;
    let staleInterval: ReturnType<typeof setInterval> | null = null;
    let landRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    let resubscribeTimeout: ReturnType<typeof setTimeout> | null = null;

    const recomputeStale = () => {
      setTurnStale(
        streamRunningRef.current &&
          runningUpdatedAtMs !== null &&
          runningUpdatedAtMs < Date.now() - TURN_STALE_MS,
      );
    };

    // After a reattached turn goes terminal, land the runner-persisted
    // authoritative history. The runner marks the stream terminal BEFORE its
    // final persist lands (and errored turns aren't persisted at all), so if
    // the fetched history doesn't contain the message we merged, retry once
    // for the persist race and otherwise keep the merged view — history
    // repair recovers on the next send.
    const landFinalMessages = async (attempt: number) => {
      if (!db) return;
      try {
        const snap = await getDoc(doc(db, 'chats', chatId));
        // Don't clobber: the chat may have changed, unmounted, or started a
        // new live HTTP turn while the fetch was in flight.
        if (!isMountedRef.current || chatIdRef.current !== chatId) return;
        const status = chatRef.current.status;
        if (status === 'streaming' || status === 'submitted') return;
        const messages = snap.data()?.messages;
        if (!Array.isArray(messages)) return;
        if (
          mergedMessageId !== null &&
          !messages.some((m) => (m as UIMessage | null)?.id === mergedMessageId)
        ) {
          if (attempt === 0) {
            landRetryTimeout = setTimeout(() => void landFinalMessages(1), 1500);
          }
          return;
        }
        chatRef.current.setMessages(messages as UIMessage[]);
      } catch (error) {
        console.error('Failed to load final chat history after reattach:', error);
      }
    };

    const unsubscribe = onSnapshot(
      streamDocRef,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        const running = data?.status === 'running';

        streamRunningRef.current = running;
        // Track the running turn's id so stop() can address it; clear the
        // user-stop guard once the doc is terminal/absent (its purpose — one-shot
        // resurrection suppression — is spent the moment the turn stops running).
        currentTurnIdRef.current =
          running && typeof data?.turnId === 'string' ? data.turnId : null;
        if (!running) userStoppedRef.current = false;
        runningUpdatedAtMs =
          running && typeof data?.updatedAt?.toMillis === 'function'
            ? (data.updatedAt.toMillis() as number)
            : null;
        recomputeStale();
        // `updatedAt` going stale doesn't emit a snapshot by itself — poll
        // while a running doc is held.
        if (running && staleInterval === null) {
          staleInterval = setInterval(recomputeStale, TURN_STALE_RECHECK_MS);
        } else if (!running && staleInterval !== null) {
          clearInterval(staleInterval);
          staleInterval = null;
        }

        // Cancel targets only exist for a live turn — {} once terminal/absent.
        const commands = running
          ? ((data?.toolCommands ?? {}) as TurnToolCommands)
          : {};
        toolCommandsRef.current = commands;
        setToolCommands(commands);

        const chatStatus = chatRef.current.status;
        const hasLiveHttpStream = chatStatus === 'streaming' || chatStatus === 'submitted';

        if (hasLiveHttpStream) {
          // We own a live HTTP stream — NEVER merge Firestore snapshots over
          // it (they lag behind and would clobber the streamed message).
          reattached = false;
          mergedMessageId = null;
        } else if (running) {
          // No live HTTP stream for a running turn (page reload mid-turn, or
          // the stream died): reattach and watch the turn via Firestore.
          reattached = true;
          // ...unless the user just pressed stop: don't resurrect the
          // in-progress message in the window before the doc flips to
          // 'cancelled'. The terminal transition (running→false) clears the
          // guard, and landFinalMessages then lands the persisted history.
          const message = userStoppedRef.current ? null : (data?.message as UIMessage | null);
          if (message && typeof message === 'object' && typeof message.id === 'string') {
            mergedMessageId = message.id;
            chatRef.current.setMessages((prev) => {
              const index = prev.findIndex((m) => m.id === message.id);
              if (index === -1) return [...prev, message];
              const next = prev.slice();
              next[index] = message;
              return next;
            });
          }
        } else if (reattached) {
          // The turn we were watching went terminal — land the final history.
          reattached = false;
          void landFinalMessages(0);
        }
      },
      (error) => {
        // The listener is dead once this fires. permission-denied is expected
        // for a brand-new chat: stream reads authorize via the parent chat doc
        // (owner lookup in firestore.rules), which the runner only creates on
        // its first final persist. Schedule a resubscribe so turn state comes
        // live once the chat exists; log anything else.
        const code = (error as { code?: string } | null)?.code;
        if (code !== 'permission-denied') {
          console.error('Failed to subscribe to turn stream:', error);
        }
        streamRunningRef.current = false;
        currentTurnIdRef.current = null;
        userStoppedRef.current = false;
        runningUpdatedAtMs = null;
        toolCommandsRef.current = {};
        setToolCommands({});
        setTurnStale(false);
        if (staleInterval !== null) {
          clearInterval(staleInterval);
          staleInterval = null;
        }
        resubscribeTimeout = setTimeout(
          () => setStreamSubAttempt((attempt) => attempt + 1),
          STREAM_RESUBSCRIBE_MS,
        );
      },
    );

    return () => {
      unsubscribe();
      if (staleInterval !== null) clearInterval(staleInterval);
      if (landRetryTimeout !== null) clearTimeout(landRetryTimeout);
      if (resubscribeTimeout !== null) clearTimeout(resubscribeTimeout);
    };
  }, [user, chatId, streamSubAttempt]);

  // Cancel a running tool call across EVERY machine it dispatched to: the agent
  // kills each command's process tree and the tool card resolves to "cancelled
  // by user" via the stream doc. `toolCallId` comes from the message part; the
  // per-machine commandId + machineId come from `toolCommands[toolCallId]` (a
  // site-wide fan-out records one entry per machine, so a single cancel targets
  // them all — in a single-machine chat this iterates exactly one entry). The
  // POSTs fire in parallel; individual failures are logged, never thrown.
  const cancelTool = useCallback(async (toolCallId: string) => {
    const perMachine = toolCommandsRef.current[toolCallId];
    if (!perMachine) return;
    await Promise.allSettled(
      Object.entries(perMachine).map(async ([machineId, { commandId }]) => {
        try {
          const response = await fetch('/api/hoot/cancel-tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteId: siteIdRef.current,
              machineId,
              chatId: chatIdRef.current,
              commandId,
            }),
          });
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            console.error('Failed to cancel tool:', response.status, detail);
          }
        } catch (error) {
          console.error('Failed to cancel tool:', error);
        }
      }),
    );
  }, []);

  // Stop = real server cancel. `chat.stop()` alone only aborts our local HTTP
  // branch; the detached server-side runner keeps executing its tool loop and
  // the reattach subscription would resurrect the response within ~1s. So when
  // the stream doc reports a running turn, POST /api/hoot/stop to flip it to
  // `cancelled` (which aborts the runner's tool loop), set the one-shot
  // resurrection guard, and still tear down the local HTTP stream. Same-origin
  // session auth (mirrors the categorize/cancel-tool fetches). Never throws.
  const stop = useCallback(async () => {
    const turnId = currentTurnIdRef.current;
    const running = streamRunningRef.current;
    // Set before any await so a snapshot arriving during the POST is suppressed.
    userStoppedRef.current = true;
    if (running && turnId) {
      try {
        const response = await fetch('/api/hoot/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: chatIdRef.current, turnId }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          console.error('Failed to stop turn:', response.status, detail);
        }
      } catch (error) {
        console.error('Failed to stop turn:', error);
      }
    }
    // Tear down the local HTTP stream regardless of the server round-trip.
    await chatRef.current.stop();
  }, []);

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
      // Keep the unpersisted draft pinned until its doc lands in a snapshot.
      const draft = draftConvoRef.current;
      if (draft) {
        if (seen.has(draft.id)) {
          draftConvoRef.current = null; // persisted now — the real doc supersedes it
        } else {
          deduped.unshift(draft);
        }
      }
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
    loadChatRequestRef.current += 1;
    const newId = generateChatId();
    setChatId(newId);
    chat.setMessages([]);
    setInputValue('');
    setPendingImages([]);
    setChatLoadError(null);

    // Use overrides if provided (handles race condition when machine selector changes in same handler)
    const effectiveMachineId = overrides?.machineId ?? machineIdRef.current;
    const effectiveMachineName = overrides?.machineName ?? machineNameRef.current;
    const isSiteMode = effectiveMachineId === SITE_TARGET_ID;

    // Add optimistic entry to the sidebar. Track it by id (in a ref) so the
    // snapshot listener can preserve it; drop only the *previous* draft by id
    // (not every "new conversation"-titled row, which could be a real chat).
    const previousDraftId = draftConvoRef.current?.id;
    const draft: ChatConversation = {
      id: newId,
      title: 'new conversation',
      siteId: siteIdRef.current,
      targetType: isSiteMode ? 'site' : 'machine',
      targetMachineId: isSiteMode ? null : effectiveMachineId,
      machineName: isSiteMode ? 'All Machines' : effectiveMachineName,
      source: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    draftConvoRef.current = draft;
    setConversations((prev) => [
      draft,
      ...prev.filter((c) => c.id !== newId && c.id !== previousDraftId),
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
      const requestId = loadChatRequestRef.current + 1;
      loadChatRequestRef.current = requestId;
      setChatId(conversationId);
      setInputValue('');
      setChatLoadError(null);
      chat.setMessages([]);

      // Fetch persisted messages from Firestore
      if (db) {
        try {
          const chatDoc = await getDoc(doc(db, 'chats', conversationId));
          if (!isMountedRef.current || requestId !== loadChatRequestRef.current) return;
          if (!chatDoc.exists()) {
            setChatLoadError('not_found');
            chat.setMessages([]);
            return;
          }

          const data = chatDoc.data();
          setChatLoadError(null);
          if (data?.messages && Array.isArray(data.messages)) {
            chat.setMessages(data.messages as UIMessage[]);
          } else {
            chat.setMessages([]);
          }
        } catch (error) {
          if (!isMountedRef.current || requestId !== loadChatRequestRef.current) return;
          // permission-denied is expected when the URL points at a chat the user
          // doesn't own (or an autonomous chat for a site they can't access) —
          // firestore.rules correctly denies it. Surface as not_found without
          // logging noise; only log genuinely unexpected failures.
          const code = (error as { code?: string } | null)?.code;
          if (code !== 'permission-denied') {
            console.error('Failed to load chat messages:', error);
          }
          setChatLoadError('not_found');
          chat.setMessages([]);
        }
      }
    },
    [chat]
  );

  const deleteChat = useCallback(
    async (conversationId: string) => {
      loadChatRequestRef.current += 1;

      // Check if this is an unpersisted "new conversation" (no messages sent yet)
      const isEmptyNew = conversations.find(
        (c) => c.id === conversationId && c.title === 'new conversation'
      );

      // Remove from local list immediately (handles both persisted and optimistic entries)
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (draftConvoRef.current?.id === conversationId) {
        draftConvoRef.current = null;
      }

      if (conversationId === chatId) {
        if (isEmptyNew) {
          // Deleted an empty "new conversation" — reset state without creating another one
          const newId = generateChatId();
          setChatId(newId);
          chat.setMessages([]);
          setInputValue('');
          setChatLoadError(null);
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

  // Sending while our own HTTP stream is live supersedes the running turn:
  // flag the request (prepareSendMessagesRequest also covers the reattached
  // case via streamRunningRef) and abort the local stream first — the SDK
  // supports one active response per chat, and the aborted request's teardown
  // would otherwise clear the new one's state. The macrotask yield lets that
  // teardown (fetch rejection → catch/finally) complete before the next send.
  const supersedeLiveStream = useCallback(async () => {
    if (chatRef.current.status !== 'streaming' && chatRef.current.status !== 'submitted') return;
    forceSupersedeRef.current = true;
    await chatRef.current.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, []);

  const handleSend = useCallback(async () => {
    const readyImages = pendingImages.filter((i) => !i.uploading);
    if (!inputValue.trim() && readyImages.length === 0) return;

    const files: FileUIPart[] = readyImages.map((i) => ({
      type: 'file' as const,
      mediaType: i.mediaType,
      url: i.url,
    }));

    await supersedeLiveStream();

    if (files.length > 0) {
      chat.sendMessage({ text: inputValue || '', files });
    } else {
      chat.sendMessage({ text: inputValue });
    }
    setInputValue('');
    setPendingImages([]);
    setChatLoadError(null);
  }, [inputValue, pendingImages, chat, supersedeLiveStream]);

  // Edit a prior user message and re-send from that point: drop the edited
  // message and everything after it, then send the new text as a fresh turn.
  // This branches the conversation linearly — the discarded tail is replaced
  // by the new assistant response and overwritten by the runner's server-side
  // persist. Any images on the original message are carried over.
  const editMessage = useCallback(
    async (messageId: string, newText: string) => {
      const trimmed = newText.trim();
      if (!trimmed) return;

      // Abort/supersede a live turn first so the message list is settled
      // before we branch it (the abort keeps any generated tokens).
      await supersedeLiveStream();

      const messages = chatRef.current.messages;
      const index = messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const original = messages[index];
      if (original.role !== 'user') return;

      const files = original.parts.filter(
        (p): p is FileUIPart => p.type === 'file',
      );

      chat.setMessages(messages.slice(0, index));
      setChatLoadError(null);

      if (files.length > 0) {
        chat.sendMessage({ text: trimmed, files });
      } else {
        chat.sendMessage({ text: trimmed });
      }
    },
    [chat, supersedeLiveStream],
  );

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

  // Patch categories into local state (for conversations outside snapshot window)
  const updateConversationCategories = useCallback((results: Record<string, string>) => {
    setConversations((prev) =>
      prev.map((c) => (results[c.id] ? { ...c, category: results[c.id] } : c))
    );
  }, []);

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
    // Real server-side cancel (POSTs /api/hoot/stop, then aborts the local
    // HTTP stream) — not the raw SDK stop, which would let the runner continue.
    stop,
    status: chat.status,
    // Re-run the last turn — used to recover from a dropped/failed stream
    // (clears the stuck in-flight tool card and regenerates the response).
    regenerate: chat.regenerate,
    // Edit a prior user message and branch the conversation from there.
    editMessage,

    // Tier-3 tool approval (human-in-the-loop). Pass the approvalId from a
    // tool part in `approval-requested` state. `sendAutomaticallyWhen` resumes
    // the stream once every pending approval on the message is answered.
    addToolApprovalResponse: chat.addToolApprovalResponse,

    // Async turn state (chats/{chatId}/stream/current).
    // `toolCallId → machineId → { commandId }` for the running turn ({} when none).
    toolCommands,
    // Cancel a running tool call by its toolCallId — fans out to every machine
    // the call dispatched to.
    cancelTool,
    // Running turn whose heartbeat is >45s old — runner likely killed by a deploy.
    turnStale,

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
    chatLoadError,
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

    // Category management
    updateConversationCategories,

    // Search
    searchQuery,
    setSearchQuery,
  };
}

function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
