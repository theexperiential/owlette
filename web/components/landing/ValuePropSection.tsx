'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';

export function ValuePropSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rotate, setRotate] = useState({ x: 8, y: 0 });
  const [sheenPos, setSheenPos] = useState({ x: 50, y: 50 });
  const target = useRef({ x: 8, y: 0 });
  const current = useRef({ x: 8, y: 0 });
  const sheenTarget = useRef({ x: 50, y: 50 });
  const sheenCurrent = useRef({ x: 50, y: 50 });
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Normalize mouse position relative to container center (-1 to 1)
      const nx = (e.clientX - rect.left) / rect.width * 2 - 1;
      const ny = (e.clientY - rect.top) / rect.height * 2 - 1;
      // Map to rotation: X tilts based on vertical mouse, Y based on horizontal
      target.current = {
        x: 8 - ny * 6,   // 2deg to 14deg range
        y: nx * 5,        // -5deg to 5deg range
      };
      // Sheen follows mouse position as percentage
      sheenTarget.current = {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100,
      };
    };

    const animate = () => {
      const factor = 0.06;
      current.current = {
        x: current.current.x + (target.current.x - current.current.x) * factor,
        y: current.current.y + (target.current.y - current.current.y) * factor,
      };
      sheenCurrent.current = {
        x: sheenCurrent.current.x + (sheenTarget.current.x - sheenCurrent.current.x) * factor,
        y: sheenCurrent.current.y + (sheenTarget.current.y - sheenCurrent.current.y) * factor,
      };
      setRotate({ ...current.current });
      setSheenPos({ ...sheenCurrent.current });
      raf.current = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', handleMouseMove);
    raf.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <section className="pt-0 sm:pt-0 pb-0 px-4 sm:px-6 -mt-32 sm:-mt-48">
      {/* Product screenshot with mouse-reactive 3D tilt */}
      <div ref={containerRef} className="max-w-6xl mx-auto mb-6 sm:mb-8" style={{ perspective: '1800px' }}>
        <Link
          href="/demo"
          target="_blank"
          className="block relative rounded-xl overflow-hidden cursor-pointer"
          style={{
            transform: `rotateX(${rotate.x}deg) rotateY(${rotate.y}deg)`,
            transformOrigin: 'center center',
            boxShadow: '0 80px 160px -30px rgba(0, 0, 0, 0.6), 0 40px 80px -20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05)',
            willChange: 'transform',
          }}
        >
          <Image
            src="/dashboard.png"
            alt="Owlette dashboard showing 10 machines with real-time metrics"
            width={2400}
            height={1300}
            className="w-full h-auto"
            priority
          />
          {/* Sheen overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(ellipse 600px 400px at ${sheenPos.x}% ${sheenPos.y}%, rgba(255, 255, 255, 0.06) 0%, transparent 70%)`,
            }}
          />
        </Link>
      </div>
      <div className="text-center mb-12 sm:mb-16">
        <Link
          href="/demo"
          target="_blank"
          className="inline-flex items-center gap-1.5 text-sm text-accent-cyan hover:text-accent-cyan-hover transition-colors group"
        >
          explore the live demo
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      {/* Text below */}
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="section-headline text-foreground mb-4 leading-tight">
          one dashboard for every screen, every machine, everywhere.
        </h2>
        <p className="section-subheadline text-balance">
          owlette lets you monitor, control, and update all of your computers
          remotely &mdash; so you always know they&apos;re running, even when
          you&apos;re not there.
        </p>
      </div>
    </section>
  );
}
