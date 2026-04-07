'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Brain, ChevronDown, ChevronLeft, ChevronRight, Power, Rocket, X, type LucideIcon } from 'lucide-react';
import Image from 'next/image';

const capabilities: { label: string; detail: string; expanded: string; preview: string; icon: LucideIcon }[] = [
  {
    label: 'monitor',
    detail: 'real-time metrics and email/webhook notifications',
    expanded: 'live cpu, memory, gpu, and disk usage for every machine. inline sparkline charts track trends over time. know instantly when something drifts.',
    preview: '/monitor.png',
    icon: Activity,
  },
  {
    label: 'control',
    detail: 'start, stop, or restart any process — with a full API',
    expanded: 'full remote process control across your entire fleet. configure startup sequences, manage dependencies, and auto-restart crashed processes before anyone notices.',
    preview: '/control.png',
    icon: Power,
  },
  {
    label: 'deploy',
    detail: 'push software updates to all machines at once',
    expanded: 'deploy software, configurations, and content to any machine, anywhere. fleet-wide rollouts or targeted single-machine updates — your call.',
    preview: '/preview-deploy.png',
    icon: Rocket,
  },
  {
    label: 'converse',
    detail: 'talk to your machines like a human with cortex',
    expanded: 'cortex lets you talk to your machines in natural language. ask questions, run diagnostics, and execute commands across your fleet through a conversational interface.',
    preview: '/preview-converse.png',
    icon: Brain,
  },
];

export function UseCaseSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dragging: boolean; didDrag: boolean; startX: number; startY: number; startPanX: number; startPanY: number }>({
    dragging: false, didDrag: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0,
  });
  const touchRef = useRef<{ startDist: number; startScale: number; startX: number; startY: number; startPanX: number; startPanY: number; didInteract: boolean }>({
    startDist: 0, startScale: 1, startX: 0, startY: 0, startPanX: 0, startPanY: 0, didInteract: false,
  });
  const isZoomed = scale > 1;
  const lightboxOpen = lightboxIndex !== null;
  const lightboxSrc = lightboxOpen ? capabilities[lightboxIndex].preview : null;

  const toggle = (i: number) => {
    setOpenIndex(openIndex === i ? null : i);
  };

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
    setScale(1);
    setPan({ x: 0, y: 0 });
    dragRef.current = { dragging: false, didDrag: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };
  }, []);

  const goTo = useCallback((index: number) => {
    setLightboxIndex(index);
    setOpenIndex(index);
    setScale(1);
    setPan({ x: 0, y: 0 });
    dragRef.current = { dragging: false, didDrag: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };
  }, []);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLightboxIndex((prev) => {
          if (prev === null) return null;
          const next = (prev + 1) % capabilities.length;
          setOpenIndex(next);
          return next;
        });
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setLightboxIndex((prev) => {
          if (prev === null) return null;
          const next = (prev - 1 + capabilities.length) % capabilities.length;
          setOpenIndex(next);
          return next;
        });
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightboxOpen, closeLightbox]);

  // Scroll wheel zoom — block page scroll while lightbox is open
  useEffect(() => {
    if (!lightboxOpen) return;
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setScale((prev) => {
        const next = Math.max(1, Math.min(prev + delta * prev, 10));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [lightboxOpen]);

  // Touch: pinch-to-zoom + single-finger pan
  useEffect(() => {
    if (!lightboxOpen) return;
    const el = overlayRef.current;
    if (!el) return;

    const dist = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        touchRef.current = { startDist: d, startScale: scale, startX: 0, startY: 0, startPanX: pan.x, startPanY: pan.y, didInteract: false };
      } else if (e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        touchRef.current = { startDist: 0, startScale: scale, startX: e.touches[0].clientX, startY: e.touches[0].clientY, startPanX: pan.x, startPanY: pan.y, didInteract: false };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const newScale = Math.max(1, Math.min(touchRef.current.startScale * (d / touchRef.current.startDist), 10));
        touchRef.current.didInteract = true;
        setScale(newScale);
        if (newScale === 1) setPan({ x: 0, y: 0 });
      } else if (e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - touchRef.current.startX;
        const dy = e.touches[0].clientY - touchRef.current.startY;
        touchRef.current.didInteract = true;
        setPan({ x: touchRef.current.startPanX + dx, y: touchRef.current.startPanY + dy });
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [lightboxOpen, scale, pan]);

  const activePreview = openIndex !== null ? capabilities[openIndex].preview : undefined;

  return (
    <section className="pt-24 sm:pt-32 pb-20 sm:pb-32 px-4 sm:px-6 relative">
      <div className="max-w-5xl mx-auto relative">

        {/* Mobile: single-column accordion — each card owns its expanded content */}
        <div className="flex flex-col gap-2 lg:hidden">
          {capabilities.map((cap, i) => (
            <div key={cap.label}>
              <button
                onClick={() => toggle(i)}
                className={`w-full text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 border ${openIndex === i ? 'bg-card/60 border-border' : 'border-transparent hover:bg-card/50'}`}
              >
                <cap.icon className={`w-8 h-8 mx-auto mb-3 transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-muted-foreground group-hover:text-accent-cyan'}`} />
                <div className="flex items-center justify-center gap-1.5 mb-2">
                  <h3 className={`text-xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                    {cap.label}
                  </h3>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                  />
                </div>
                <p className="text-base text-muted-foreground">
                  {cap.detail}
                </p>
              </button>

              {/* Expanded content inline below the card */}
              <div className={`overflow-hidden transition-all duration-500 ease-out ${openIndex === i ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'}`}>
                <p className="text-sm text-muted-foreground/80 leading-relaxed text-center px-6 pb-4 animate-in fade-in duration-300">
                  {cap.expanded}
                </p>
                <div className="px-2 pb-4">
                  <div
                    className="relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5 cursor-zoom-in"
                    style={{
                      maskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                      WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                    }}
                    onClick={() => setLightboxIndex(i)}
                  >
                    <Image
                      src={cap.preview}
                      alt={`${cap.label} preview`}
                      width={2300}
                      height={1050}
                      className="w-full h-auto"
                      priority
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: 4-column grid with shared preview area below */}
        <div className="hidden lg:block">
          <div className="grid grid-cols-4 gap-6 items-start">
            {capabilities.map((cap, i) => (
              <button
                key={cap.label}
                onClick={() => toggle(i)}
                className={`text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 border ${openIndex === i ? 'bg-card/60 border-border' : 'border-transparent hover:bg-card/50'}`}
              >
                <cap.icon className={`w-8 h-8 mx-auto mb-3 transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-muted-foreground group-hover:text-accent-cyan'}`} />
                <div className="flex items-center justify-center gap-1.5 mb-2">
                  <h3 className={`text-2xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                    {cap.label}
                  </h3>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                  />
                </div>
                <p className="text-base text-muted-foreground">
                  {cap.detail}
                </p>
              </button>
            ))}
          </div>

          {/* Expanded text — mirrored grid so text appears below its card */}
          {openIndex !== null && (
            <div className="grid grid-cols-4 gap-6 mt-2">
              {capabilities.map((cap, i) => (
                <div key={cap.label} className={i === openIndex ? 'animate-in fade-in duration-300' : ''}>
                  {i === openIndex && (
                    <p className="text-sm text-muted-foreground/80 leading-relaxed text-center px-2">
                      {cap.expanded}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Preview image — below the grid so cards never shift */}
          <div
            className={`overflow-hidden transition-all duration-500 ease-out ${activePreview ? 'max-h-[800px] opacity-100 mt-8' : 'max-h-0 opacity-0 mt-0'}`}
          >
            <div
              className="relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5 cursor-zoom-in"
              style={{
                maskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                maskComposite: 'intersect',
                WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                WebkitMaskComposite: 'source-in',
              }}
              onClick={() => openIndex !== null && setLightboxIndex(openIndex)}
            >
              <div className="relative">
                {capabilities.map((cap) => (
                  <div
                    key={cap.preview}
                    className="transition-all duration-500 ease-out"
                    style={{
                      opacity: activePreview === cap.preview ? 1 : 0,
                      position: activePreview === cap.preview ? 'relative' : 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: activePreview === cap.preview ? 'translateY(0)' : 'translateY(12px)',
                    }}
                  >
                    <Image
                      src={cap.preview}
                      alt={`${cap.label} preview`}
                      width={2300}
                      height={1050}
                      className="w-full h-auto"
                      priority
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Lightbox overlay */}
      {lightboxOpen && lightboxSrc && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center overflow-hidden touch-none animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeLightbox();
          }}
          onMouseDown={(e) => {
            if (!isZoomed) return;
            e.preventDefault();
            dragRef.current = { dragging: true, didDrag: false, startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanY: pan.y };
          }}
          onMouseMove={(e) => {
            if (!dragRef.current.dragging) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.didDrag = true;
            setPan({ x: dragRef.current.startPanX + dx, y: dragRef.current.startPanY + dy });
          }}
          onMouseUp={() => { dragRef.current.dragging = false; }}
          onMouseLeave={() => { dragRef.current.dragging = false; }}
        >
          <button
            onClick={closeLightbox}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <X className="w-6 h-6 text-white" />
          </button>

          {/* Prev / Next arrows */}
          <button
            onClick={(e) => { e.stopPropagation(); goTo((lightboxIndex - 1 + capabilities.length) % capabilities.length); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-6 h-6 text-white" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goTo((lightboxIndex + 1) % capabilities.length); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <ChevronRight className="w-6 h-6 text-white" />
          </button>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={lightboxSrc}
            alt={`${capabilities[lightboxIndex].label} preview`}
            draggable={false}
            className={`select-none max-w-[95vw] max-h-[95vh] object-contain ${
              isZoomed
                ? 'cursor-grab active:cursor-grabbing'
                : 'cursor-zoom-in animate-in zoom-in-95 duration-200'
            }`}
            style={{
              transformOrigin: 'center center',
              transition: dragRef.current.dragging ? 'none' : 'transform 0.2s ease-out',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (dragRef.current.didDrag) return;
              if (!isZoomed && imgRef.current) {
                setScale(imgRef.current.naturalWidth / imgRef.current.clientWidth);
                setPan({ x: 0, y: 0 });
              } else {
                setScale(1);
                setPan({ x: 0, y: 0 });
              }
            }}
          />

          {/* Caption under image */}
          <p className="absolute bottom-14 left-1/2 -translate-x-1/2 z-10 text-lg text-white/70 text-center whitespace-nowrap">
            {capabilities[lightboxIndex].detail}
          </p>

          {/* Dot indicators */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex gap-2">
            {capabilities.map((cap, i) => (
              <button
                key={cap.label}
                onClick={(e) => { e.stopPropagation(); goTo(i); }}
                className={`w-2 h-2 rounded-full transition-all cursor-pointer ${
                  i === lightboxIndex ? 'bg-accent-cyan w-6' : 'bg-white/30 hover:bg-white/50'
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
