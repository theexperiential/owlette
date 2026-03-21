'use client';

import React, { useRef, useCallback } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
}

export function ChatInput({ input, isLoading, onInputChange, onSubmit, onStop }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (input.trim() && !isLoading) {
          onSubmit(e as unknown as React.FormEvent);
        }
      }
    },
    [input, isLoading, onSubmit]
  );

  // Auto-resize textarea
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onInputChange(e);
      const textarea = e.target;
      textarea.style.height = '40px';
      textarea.style.height = `${Math.max(40, Math.min(textarea.scrollHeight, 200))}px`;
    },
    [onInputChange]
  );

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <form onSubmit={onSubmit} className="max-w-3xl mx-auto">
        <div className="flex gap-2 items-stretch" style={{ minHeight: '40px' }}>
          <textarea
            ref={textareaRef}
            data-chat-input
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="ask about this machine..."
            rows={1}
            className="flex-1 resize-none rounded-lg border border-border bg-secondary px-4 py-2 text-sm leading-normal text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan"
            disabled={isLoading}
          />

          {isLoading ? (
            <Button
              type="button"
              onClick={onStop}
              size="icon"
              variant="outline"
              className="!h-auto w-10 rounded-lg border-border bg-secondary hover:bg-accent flex-shrink-0"
            >
              <Square className="h-4 w-4 text-foreground" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim()}
              className="!h-auto w-10 rounded-lg bg-accent-cyan hover:bg-accent-cyan-hover disabled:opacity-50 flex-shrink-0"
            >
              <Send className="h-4 w-4 text-gray-900" />
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground/60 text-center">
          responses may be inaccurate. commands run directly on the selected machine.
        </p>
      </form>
    </div>
  );
}
