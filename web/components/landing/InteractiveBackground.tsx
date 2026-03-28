'use client';

import { useEffect, useRef, useState } from 'react';

interface MousePosition {
  x: number;
  y: number;
}

export function InteractiveBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState<MousePosition>({ x: 0.5, y: 0.5 });
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const animationRef = useRef<number | null>(null);
  const targetPos = useRef<MousePosition>({ x: 0.5, y: 0.5 });
  const currentPos = useRef<MousePosition>({ x: 0.5, y: 0.5 });

  // Detect touch device and reduced motion preference
  useEffect(() => {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setIsTouchDevice(isTouch);
    setPrefersReducedMotion(reducedMotion);
  }, []);

  useEffect(() => {
    // Skip animation for touch devices or reduced motion
    if (isTouchDevice || prefersReducedMotion) return;

    // Track mouse globally for smooth following anywhere
    const handleMouseMove = (e: MouseEvent) => {
      // Normalize to viewport coordinates (0-1 range)
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      targetPos.current = { x, y };
    };

    // Exponential decay smoothing - very graceful falloff
    const animate = () => {
      const dx = targetPos.current.x - currentPos.current.x;
      const dy = targetPos.current.y - currentPos.current.y;

      // Exponential easing: slower as it approaches target
      // Using a very low factor for graceful, slow movement
      const factor = 0.025;

      currentPos.current = {
        x: currentPos.current.x + dx * factor,
        y: currentPos.current.y + dy * factor,
      };

      setMousePos({ ...currentPos.current });
      animationRef.current = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', handleMouseMove);
    animationRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isTouchDevice, prefersReducedMotion]);

  // Static background for touch devices or reduced motion
  if (isTouchDevice || prefersReducedMotion) {
    return (
      <div className="absolute inset-0 overflow-hidden">
        {/* Static centered glow - no animation, responsive size */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(600px,90vw)] h-[min(600px,90vw)] rounded-full blur-3xl"
          style={{
            background: 'radial-gradient(circle, oklch(0.75 0.18 195 / 0.15) 0%, transparent 60%)',
          }}
        />

      </div>
    );
  }

  // Subtle parallax offset for desktop
  const offsetX = (mousePos.x - 0.5) * 40;
  const offsetY = (mousePos.y - 0.5) * 40;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
    >
      {/* Primary glow - follows mouse, responsive size */}
      <div
        className="absolute w-[min(900px,150vw)] h-[min(900px,150vw)] rounded-full blur-3xl"
        style={{
          background: 'radial-gradient(circle, oklch(0.75 0.18 195 / 0.10) 0%, transparent 60%)',
          left: `calc(${mousePos.x * 100}% - min(450px, 75vw))`,
          top: `calc(${mousePos.y * 100}% - min(450px, 75vw))`,
        }}
      />

      {/* Secondary warm glow - offset from mouse for depth */}
      <div
        className="absolute w-[min(600px,100vw)] h-[min(600px,100vw)] rounded-full blur-3xl"
        style={{
          background: 'radial-gradient(circle, oklch(0.72 0.16 55 / 0.06) 0%, oklch(0.70 0.14 30 / 0.03) 40%, transparent 70%)',
          left: `calc(${(1 - mousePos.x) * 100}% - min(300px, 50vw))`,
          top: `calc(${(1 - mousePos.y) * 100}% - min(300px, 50vw))`,
        }}
      />

    </div>
  );
}
