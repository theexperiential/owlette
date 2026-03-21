'use client';

import React, { useEffect, useRef } from 'react';
import { type UIMessage } from 'ai';
import { Brain, User, KeyRound } from 'lucide-react';
import { ToolCallCard } from './ToolCallCard';

interface ChatWindowProps {
  messages: UIMessage[];
  isLoading: boolean;
  hasApiKey?: boolean | null;
  onOpenSettings?: () => void;
}

export function ChatWindow({ messages, isLoading, hasApiKey, onOpenSettings }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <Brain className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">cortex</h3>
          <p className="text-sm text-muted-foreground">
            debug, diagnose, and manage your remote machines.
            i can run commands, check configs, and investigate issues you can't see from the dashboard.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
              {[
                'when was the last time this PC was restarted?',
                'which nvidia driver version is installed?',
                'what does our network config look like?',
                'run a cpu and memory stability test',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  className="text-xs text-left px-3 py-2 rounded-md border border-border bg-secondary hover:bg-accent transition-colors text-muted-foreground cursor-pointer"
                  onClick={() => {
                    const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]');
                    if (input) {
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        'value'
                      )?.set;
                      nativeInputValueSetter?.call(input, suggestion);
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.focus();
                    }
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
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

            {/* Render parts (text + tool calls) */}
            {message.parts.map((part, i) => {
              if (part.type === 'text') {
                return (
                  <div
                    key={i}
                    className="text-sm text-foreground whitespace-pre-wrap break-words prose prose-invert prose-sm max-w-none"
                  >
                    {part.text}
                  </div>
                );
              }

              if (part.type.startsWith('tool-')) {
                // v6: tool parts are typed as tool-invocation, tool-result, etc.
                const toolPart = part as { type: string; toolName?: string; toolCallId?: string; args?: unknown; input?: unknown; output?: unknown; state?: string };
                const toolName = toolPart.toolName || 'unknown';
                const args = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
                const result = toolPart.output;
                const hasResult = toolPart.state === 'result' || result !== undefined;

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
        <div className="flex gap-3 max-w-3xl mx-auto">
          <div className="flex-shrink-0 mt-1">
            <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
              <Brain className="h-4 w-4 text-foreground" />
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="flex gap-1">
              <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
              <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
              <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
            </div>
            thinking...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
