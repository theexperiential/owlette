'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { OwletteEye } from '@/components/landing/OwletteEye';

function RainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const initDrops = useCallback((width: number, height: number) => {
    const spacing = 24;
    const cols = Math.floor(width / spacing);
    const drops: { x: number; y: number; speed: number; opacity: number }[] = [];
    for (let i = 0; i < cols; i++) {
      drops.push({
        x: i * spacing + spacing / 2,
        y: Math.random() * height,
        speed: 0.5 + Math.random() * 1.0,
        opacity: 0.1 + Math.random() * 0.2,
      });
    }
    return drops;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let drops: ReturnType<typeof initDrops>;

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      drops = initDrops(canvas!.width, canvas!.height);
    }

    resize();
    window.addEventListener('resize', resize);

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      for (const drop of drops) {
        ctx!.beginPath();
        ctx!.arc(drop.x, drop.y, 1.35, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(97, 112, 155, ${drop.opacity + 0.05})`;
        ctx!.fill();

        drop.y += drop.speed;
        if (drop.y > canvas!.height + 10) {
          drop.y = -10;
          drop.opacity = 0.05 + Math.random() * 0.15;
        }
      }
      animId = requestAnimationFrame(draw);
    }

    draw();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, [initDrops]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 1 }}
    />
  );
}

export default function NotFound() {
  const [glitch, setGlitch] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setGlitch(true);
      setTimeout(() => setGlitch(false), 200);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative min-h-[100dvh] flex flex-col items-center justify-center overflow-hidden">
      {/* Dot grid background */}
      <div className="absolute inset-0 dot-grid opacity-40" />

      {/* Raining dots */}
      <RainCanvas />

      {/* Radial glow behind the eye */}
      <div
        className="absolute w-[600px] h-[600px] rounded-full blur-3xl opacity-30"
        style={{
          background: 'radial-gradient(circle, oklch(0.70 0.14 30 / 0.4) 0%, oklch(0.72 0.16 55 / 0.15) 40%, transparent 70%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center px-6">
        {/* The Eye */}
        <div className="relative mb-10 animate-in fade-in zoom-in-50 duration-1000">
          <OwletteEye size={180} className="drop-shadow-2xl" animated />
        </div>

        {/* 404 */}
        <h1
          className={`font-mono text-[10rem] sm:text-[14rem] font-bold leading-none tracking-tighter mb-10 transition-all duration-100 ${
            glitch
              ? 'text-accent-coral skew-x-2 scale-x-[1.02]'
              : 'text-foreground/10'
          }`}
          style={{
            textShadow: glitch
              ? '3px 0 oklch(0.75 0.18 195), -3px 0 oklch(0.70 0.14 30)'
              : 'none',
          }}
        >
          404
        </h1>

        {/* One-liner */}
        <p className="text-2xl sm:text-3xl text-muted-foreground font-light tracking-wide mb-20 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
          all these pages will be lost in time...
          <br className="mb-0" />
          <span className="inline-block mt-3">like tears in rain.</span>
        </p>

        {/* Single CTA */}
        <Button
          asChild
          size="lg"
          className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-10 h-14 text-lg animate-in fade-in slide-in-from-bottom-6 duration-700 delay-500"
        >
          <Link href="/">go home</Link>
        </Button>
      </div>
    </div>
  );
}
