'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, User, KeyRound, X } from 'lucide-react';
import { ToolCallCard } from './ToolCallCard';
import { SynapticIndicator } from './SynapticIndicator';
import { getRandomSuggestions } from '../data/suggestedQuestions';

interface ChatWindowProps {
  messages: UIMessage[];
  isLoading: boolean;
  hasApiKey?: boolean | null;
  onOpenSettings?: () => void;
}

export function ChatWindow({ messages, isLoading, hasApiKey, onOpenSettings }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const suggestions = useMemo(() => getRandomSuggestions(4), []);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    // "Near bottom" = within 100px of the bottom edge
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    isUserScrolledUp.current = !nearBottom;
  };

  useEffect(() => {
    if (!isUserScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!expandedImage) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedImage(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [expandedImage]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <Brain className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-2">cortex</h2>
          <p className="text-sm text-muted-foreground">
            debug, diagnose, and manage your remote machines.
            i can run commands, check configs, and investigate issues you can't see from the dashboard.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.text}
                  className="text-xs text-left px-3 py-2 rounded-md border border-border bg-secondary hover:bg-accent transition-colors text-muted-foreground cursor-pointer"
                  onClick={() => {
                    const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]');
                    if (input) {
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        'value'
                      )?.set;
                      nativeInputValueSetter?.call(input, suggestion.text);
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.focus();
                    }
                  }}
                >
                  {suggestion.text}
                </button>
              ))}
            </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {/* Lightbox overlay */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setExpandedImage(null)}
        >
          <button
            type="button"
            onClick={() => setExpandedImage(null)}
            className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="h-5 w-5 text-white" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={expandedImage}
            alt="Expanded image"
            className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {messages.map((message) => (
        <div key={message.id} className="flex gap-3 max-w-3xl mx-auto">
          {/* Avatar */}
          <div className="flex-shrink-0 mt-1">
            {message.role === 'user' ? (
              <div className="h-7 w-7 rounded-full bg-accent-cyan flex items-center justify-center">
                <User className="h-4 w-4 text-gray-900" />
              </div>
            ) : (
              <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
                <Brain className="h-4 w-4 text-foreground" />
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground mb-1">
              {message.role === 'user' ? 'you' : 'cortex'}
            </div>

            {/* Render parts (text + images + tool calls) */}
            {message.parts.map((part, i) => {
              if (part.type === 'text') {
                return (
                  <div
                    key={i}
                    className="cortex-markdown text-sm text-foreground prose prose-invert prose-sm max-w-none prose-code:before:content-none prose-code:after:content-none"
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {part.text}
                    </ReactMarkdown>
                  </div>
                );
              }

              if (part.type === 'file') {
                const filePart = part as { type: 'file'; mediaType?: string; url?: string };
                if (filePart.mediaType?.startsWith('image/') && filePart.url) {
                  return (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      key={i}
                      src={filePart.url}
                      alt="Pasted image"
                      className="max-w-sm rounded-lg border border-border my-1 cursor-pointer hover:opacity-90 transition-opacity"
                      loading="lazy"
                      onClick={() => setExpandedImage(filePart.url!)}
                    />
                  );
                }
                return null;
              }

              if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                // v6: static tool parts have type 'tool-{name}', dynamic ones have type 'dynamic-tool' with toolName
                const toolPart = part as { type: string; toolName?: string; toolCallId?: string; args?: unknown; input?: unknown; output?: unknown; state?: string };
                const toolName = toolPart.type === 'dynamic-tool'
                  ? (toolPart.toolName || 'unknown')
                  : toolPart.type.slice(5); // strip 'tool-' prefix
                const args = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
                const result = toolPart.output;
                const hasResult = toolPart.state === 'output-available' || toolPart.state === 'output-error' || toolPart.state === 'result' || result !== undefined;

                return (
                  <ToolCallCard
                    key={i}
                    toolName={toolName}
                    args={args}
                    result={hasResult ? result : undefined}
                    isLoading={!hasResult}
                  />
                );
              }

              return null;
            })}
          </div>
        </div>
      ))}

      {/* Loading indicator */}
      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div className="flex items-center gap-3 max-w-3xl mx-auto">
          <div className="flex-shrink-0">
            <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
              <Brain className="h-4 w-4 text-foreground" />
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <SynapticIndicator />
            thinking...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
