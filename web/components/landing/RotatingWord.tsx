'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const words = ['monitor', 'deploy to', 'converse with', 'command', 'control'];

export function RotatingWord() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [width, setWidth] = useState<number>(0);
  const hiddenRef = useRef<HTMLSpanElement>(null);

  // Measure width of upcoming word using a hidden element
  const measureWord = useCallback((wordIndex: number) => {
    if (hiddenRef.current) {
      hiddenRef.current.textContent = words[wordIndex];
      return hiddenRef.current.offsetWidth;
    }
    return 0;
  }, []);

  // Set initial width
  useEffect(() => {
    setWidth(measureWord(0));
  }, [measureWord]);

  useEffect(() => {
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
    }, 2800);

    return () => clearInterval(interval);
  }, [index, measureWord]);

  return (
    <>
      {/* Hidden measurer — same font styling, off-screen */}
      <span
        ref={hiddenRef}
        className="absolute invisible whitespace-nowrap"
        aria-hidden="true"
      />
      <span
        className="inline-flex justify-end overflow-hidden transition-[width] duration-500 ease-in-out whitespace-nowrap"
        style={{ width: `${width}px` }}
      >
        <span
          className={`transition-all duration-400 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}
        >
          {words[index]}
        </span>
      </span>
    </>
  );
}
