'use client';

import { useState, useEffect } from 'react';

interface TypewriterLine {
  text: string;
  className?: string;
}

interface TypewriterTextProps {
  lines: TypewriterLine[];
  typingSpeed?: number;
  delayBetweenLines?: number;
  startDelay?: number;
  className?: string;
}

export function TypewriterText({
  lines,
  typingSpeed = 50,
  delayBetweenLines = 200,
  startDelay = 500,
  className = '',
}: TypewriterTextProps) {
  const [displayedLines, setDisplayedLines] = useState<string[]>(lines.map(() => ''));
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [showCursor, setShowCursor] = useState(true);

  // Blinking cursor effect
  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 530);

    return () => clearInterval(cursorInterval);
  }, []);

  // Start typing after delay
  useEffect(() => {
    const startTimeout = setTimeout(() => {
      setIsTyping(true);
    }, startDelay);

    return () => clearTimeout(startTimeout);
  }, [startDelay]);

  // Typing effect
  useEffect(() => {
    if (!isTyping) return;

    const currentLine = lines[currentLineIndex];
    if (!currentLine) return;

    if (currentCharIndex < currentLine.text.length) {
      const timeout = setTimeout(() => {
        setDisplayedLines((prev) => {
          const newLines = [...prev];
          newLines[currentLineIndex] = currentLine.text.slice(0, currentCharIndex + 1);
          return newLines;
        });
        setCurrentCharIndex((prev) => prev + 1);
      }, typingSpeed);

      return () => clearTimeout(timeout);
    } else if (currentLineIndex < lines.length - 1) {
      // Move to next line after delay
      const timeout = setTimeout(() => {
        setCurrentLineIndex((prev) => prev + 1);
        setCurrentCharIndex(0);
      }, delayBetweenLines);

      return () => clearTimeout(timeout);
    }
  }, [isTyping, currentLineIndex, currentCharIndex, lines, typingSpeed, delayBetweenLines]);

  const isComplete = currentLineIndex === lines.length - 1 &&
    currentCharIndex >= lines[lines.length - 1].text.length;

  return (
    <span className={`flex flex-col gap-0 ${className}`}>
      {lines.map((line, index) => {
        const isLastLine = index === lines.length - 1;
        const showCursorOnThisLine = index === currentLineIndex && !isComplete;
        const showFinalCursor = isLastLine && isComplete;

        return (
          <span key={index} className="relative block leading-[1.05]">
            {/* Invisible placeholder to reserve space for full line + cursor */}
            <span className="invisible" aria-hidden="true">
              {line.text}_
            </span>
            {/* Visible typed text overlaid on placeholder */}
            <span className={`absolute inset-0 ${line.className || ''}`}>
              {displayedLines[index]}
              {/* Show cursor while typing this line */}
              {showCursorOnThisLine && (
                <span
                  className={`inline-block w-[0.6em] ${showCursor ? 'opacity-100' : 'opacity-0'} transition-opacity duration-100`}
                >
                  _
                </span>
              )}
              {/* Show cursor at end when complete (on last line) */}
              {showFinalCursor && (
                <span
                  className={`inline-block w-[0.6em] text-accent-cyan ${showCursor ? 'opacity-100' : 'opacity-0'} transition-opacity duration-100`}
                >
                  _
                </span>
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}
