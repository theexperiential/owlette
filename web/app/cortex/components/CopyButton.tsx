'use client';

import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  className?: string;
  iconSize?: 'xs' | 'sm';
}

export function CopyButton({ value, className = '', iconSize = 'xs' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore
    }
  };

  const size = iconSize === 'sm' ? 'h-3.5 w-3.5' : 'h-3 w-3';

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 p-0 bg-transparent border-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer ${className}`}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      aria-label="Copy to clipboard"
      type="button"
    >
      {copied ? (
        <Check className={`${size} text-green-400`} />
      ) : (
        <Copy className={size} />
      )}
    </button>
  );
}
