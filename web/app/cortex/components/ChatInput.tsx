'use client';

import React, { useRef, useCallback, useState, useEffect } from 'react';
import { Send, Square, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface PendingImage {
  url: string;
  mediaType: string;
  uploading: boolean;
  /** Local object URL for preview while uploading */
  previewUrl?: string;
}

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  pendingImages: PendingImage[];
  onPasteImage: (blob: Blob) => void;
  onRemoveImage: (index: number) => void;
}

export function ChatInput({
  input,
  isLoading,
  onInputChange,
  onSubmit,
  onStop,
  pendingImages,
  onPasteImage,
  onRemoveImage,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  // Close lightbox on Escape
  useEffect(() => {
    if (!expandedImage) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedImage(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [expandedImage]);

  const canSend =
    (input.trim() || pendingImages.some((i) => !i.uploading)) && !isLoading;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend) {
          onSubmit(e as unknown as React.FormEvent);
        }
      }
    },
    [canSend, onSubmit],
  );

  // Auto-resize textarea
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onInputChange(e);
      const textarea = e.target;
      textarea.style.height = '40px';
      textarea.style.height = `${Math.max(40, Math.min(textarea.scrollHeight, 200))}px`;
    },
    [onInputChange],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            onPasteImage(blob);
          }
          return;
        }
      }
      // If no image found, let default text paste happen
    },
    [onPasteImage],
  );

  return (
    <div className="border-t border-border px-4 py-3">
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
            alt="Expanded preview"
            className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <form onSubmit={onSubmit} className="max-w-3xl mx-auto">
        {/* Image preview strip */}
        {pendingImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {pendingImages.map((img, i) => (
              <div
                key={i}
                className="relative group h-12 w-12 rounded-md border border-border bg-secondary flex-shrink-0"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl || img.url}
                  alt="Pending upload"
                  className="h-full w-full object-cover cursor-pointer rounded-md"
                  onClick={() => setExpandedImage(img.previewUrl || img.url)}
                />
                {img.uploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 className="h-4 w-4 text-white animate-spin" />
                  </div>
                )}
                {!img.uploading && (
                  <button
                    type="button"
                    onClick={() => onRemoveImage(i)}
                    className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-red-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <X className="h-2.5 w-2.5 text-white" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-stretch" style={{ minHeight: '40px' }}>
          <textarea
            ref={textareaRef}
            data-chat-input
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
              className="!h-auto w-10 rounded-lg bg-accent-cyan hover:bg-accent-cyan-hover flex-shrink-0"
            >
              <Square className="h-4 w-4 text-gray-900 fill-gray-900" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={!canSend}
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
