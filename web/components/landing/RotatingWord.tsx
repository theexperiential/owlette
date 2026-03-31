'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface RotatingWordProps {
  words: string[];
  align?: 'start' | 'end';
  delay?: number;
  direction?: 'up' | 'down';
}

export function RotatingWord({ words, align = 'end', delay = 0, direction = 'up' }: RotatingWordProps) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [width, setWidth] = useState<number>(0);
  const [started, setStarted] = useState(delay === 0);
  const hiddenRef = useRef<HTMLSpanElement>(null);

  const exitClass = direction === 'up' ? '-translate-y-2' : 'translate-y-2';

  // Cache measured widths to avoid repeated layout thrashing
  const widthCache = useRef<Map<number, number>>(new Map());

  const measureWord = useCallback((wordIndex: number) => {
    const cached = widthCache.current.get(wordIndex);
    if (cached !== undefined) return cached;
    if (hiddenRef.current) {
      hiddenRef.current.textContent = words[wordIndex];
      const w = hiddenRef.current.offsetWidth;
      widthCache.current.set(wordIndex, w);
      return w;
    }
    return 0;
  }, [words]);

  // Set initial width
  useEffect(() => {
    setWidth(measureWord(0));
  }, [measureWord]);

  // Start cycling after delay
  useEffect(() => {
    if (delay > 0) {
      const timer = setTimeout(() => setStarted(true), delay);
      return () => clearTimeout(timer);
    }
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    const interval = setInterval(() => {
      setVisible(false);
      const nextIndex = (index + 1) % words.length;
      // Pre-measure next word and start width transition during fade-out
      const nextWidth = measureWord(nextIndex);
      setWidth(nextWidth);
      setTimeout(() => {
        setIndex(nextIndex);
        setVisible(true);
      }, 400);
    }, 4000);

    return () => clearInterval(interval);
  }, [index, measureWord, started, words.length]);

  return (
    <>
      {/* Hidden measurer — same font styling, off-screen */}
      <span
        ref={hiddenRef}
        className="absolute invisible whitespace-nowrap"
        aria-hidden="true"
      />
      <span
        className={`inline-flex ${align === 'end' ? 'justify-end' : 'justify-start'} overflow-hidden transition-[width] duration-500 ease-in-out whitespace-nowrap`}
        style={{ width: `${width}px` }}
      >
        <span
          className={`transition-all duration-400 ${visible ? 'opacity-100 translate-y-0' : `opacity-0 ${exitClass}`}`}
        >
          {words[index]}
        </span>
      </span>
    </>
  );
}
