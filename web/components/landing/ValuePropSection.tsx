'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';

export function ValuePropSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLAnchorElement>(null);
  const sheenRef = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 8, y: 0 });
  const current = useRef({ x: 8, y: 0 });
  const sheenTarget = useRef({ x: 50, y: 50 });
  const sheenCurrent = useRef({ x: 50, y: 50 });
  const raf = useRef<number | null>(null);
  const isVisible = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Only animate when the section is in the viewport
    const handleMouseMove = (e: MouseEvent) => {
      if (!isVisible.current) return;
      const rect = container.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width * 2 - 1;
      const ny = (e.clientY - rect.top) / rect.height * 2 - 1;
      target.current = {
        x: 8 - ny * 6,
        y: nx * 5,
      };
      sheenTarget.current = {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100,
      };
    };

    const animate = () => {
      if (!isVisible.current) {
        raf.current = null;
        return; // Stop RAF when not visible — restarted by IntersectionObserver
      }

      const factor = 0.06;
      const cur = current.current;
      const tgt = target.current;
      cur.x += (tgt.x - cur.x) * factor;
      cur.y += (tgt.y - cur.y) * factor;

      const sc = sheenCurrent.current;
      const st = sheenTarget.current;
      sc.x += (st.x - sc.x) * factor;
      sc.y += (st.y - sc.y) * factor;

      // Write directly to DOM — no React re-render
      if (tiltRef.current) {
        tiltRef.current.style.transform = `rotateX(${cur.x}deg) rotateY(${cur.y}deg)`;
      }
      if (sheenRef.current) {
        sheenRef.current.style.background = `radial-gradient(ellipse 600px 400px at ${sc.x}% ${sc.y}%, rgba(255, 255, 255, 0.06) 0%, transparent 70%)`;
      }

      raf.current = requestAnimationFrame(animate);
    };

    // Only run RAF when section is in viewport
    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible.current = entry.isIntersecting;
        if (entry.isIntersecting && !raf.current) {
          raf.current = requestAnimationFrame(animate);
        }
      },
      { threshold: 0 }
    );
    observer.observe(container);

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    raf.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (raf.current) cancelAnimationFrame(raf.current);
      observer.disconnect();
    };
  }, []);

  return (
    <section className="pt-0 sm:pt-0 pb-0 px-4 sm:px-6 -mt-32 sm:-mt-48">
      {/* Product screenshot with mouse-reactive 3D tilt */}
      <div ref={containerRef} className="max-w-6xl mx-auto mb-6 sm:mb-8" style={{ perspective: '1800px' }}>
        <Link
          ref={tiltRef}
          href="/demo"
          target="_blank"
          className="block relative rounded-xl overflow-hidden cursor-pointer"
          style={{
            transform: `rotateX(8deg) rotateY(0deg)`,
            transformOrigin: 'center center',
            boxShadow: '0 80px 160px -30px rgba(0, 0, 0, 0.6), 0 40px 80px -20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05)',
            willChange: 'transform',
          }}
        >
          <Image
            src="/dashboard.png"
            alt="owlette dashboard showing 10 machines with real-time metrics"
            width={2400}
            height={1300}
            className="w-full h-auto"
            priority
          />
          {/* Sheen overlay */}
          <div
            ref={sheenRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(ellipse 600px 400px at 50% 50%, rgba(255, 255, 255, 0.06) 0%, transparent 70%)`,
            }}
          />
        </Link>
      </div>
      <div className="text-center mb-12 sm:mb-16">
        <Link
          href="/demo"
          target="_blank"
          className="inline-flex items-center gap-1.5 text-base text-accent-cyan hover:text-accent-cyan-hover transition-colors group"
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
