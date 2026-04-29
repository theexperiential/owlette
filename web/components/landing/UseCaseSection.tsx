'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Brain, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, Monitor, Power, Rocket, RotateCcw, X, type LucideIcon } from 'lucide-react';
import Image from 'next/image';

function DisplayPreviewArt() {
  return (
    <div className="relative w-full aspect-[2300/1050] bg-card/40 px-8 py-10 flex flex-col items-center justify-center gap-6">
      {/* 4-monitor mosaic with one drifted + restored indicator */}
      <div className="grid grid-cols-2 gap-3 w-full max-w-md aspect-[16/9]">
        {[1, 2, 3, 4].map((n) => {
          const drifted = n === 3;
          return (
            <div
              key={n}
              className={`relative rounded-md border flex items-center justify-center transition-colors ${
                drifted
                  ? 'border-accent-warm/50 bg-accent-warm/10'
                  : 'border-accent-cyan/40 bg-accent-cyan/10'
              }`}
            >
              <span className={`text-sm font-mono ${drifted ? 'text-accent-warm' : 'text-accent-cyan/80'}`}>
                {n}
              </span>
              {drifted && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-accent-cyan flex items-center justify-center ring-2 ring-card">
                  <Check className="w-2.5 h-2.5 text-background" strokeWidth={3} />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Status row */}
      <div className="flex items-center gap-6 text-xs font-mono">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Eye className="w-3 h-3" /> watching
        </span>
        <span className="flex items-center gap-1.5 text-accent-warm">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-warm" />
          monitor 3 drifted
        </span>
        <span className="flex items-center gap-1.5 text-accent-cyan">
          <RotateCcw className="w-3 h-3" />
          auto-restored
        </span>
      </div>
    </div>
  );
}

function AutomatePreviewArt() {
  const rules = [
    { when: 'mon-fri · 04:00', what: 'reboot lobby-display, museum-kiosk-*', tag: 'reboot' },
    { when: 'on boot', what: 'launch obs64.exe, then touchdesigner.exe', tag: 'sequence' },
    { when: 'cpu > 90% for 5min', what: 'restart media-server-stage', tag: 'rule' },
    { when: 'sun · 03:00', what: 'pull latest content, deploy roost v4', tag: 'deploy' },
  ];
  const tagColor: Record<string, string> = {
    reboot: 'text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10',
    sequence: 'text-accent-warm border-accent-warm/40 bg-accent-warm/10',
    rule: 'text-foreground/80 border-border bg-card/40',
    deploy: 'text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10',
  };
  return (
    <div className="relative w-full aspect-[2300/1050] bg-card/40 p-8 flex flex-col gap-3 justify-center">
      <div className="flex items-center justify-between mb-1 px-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-mono">
          schedule
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-accent-cyan font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan" />
          4 rules active
        </span>
      </div>
      {rules.map((rule, i) => (
        <div
          key={i}
          className="flex items-center gap-4 rounded-md border border-border bg-card/60 px-4 py-3"
        >
          <span className="text-xs font-mono text-muted-foreground w-44 flex-shrink-0 truncate">
            {rule.when}
          </span>
          <span className="text-xs text-foreground/90 flex-1 truncate">
            {rule.what}
          </span>
          <span className={`hidden sm:inline-flex items-center text-[10px] font-mono px-2 py-0.5 rounded border ${tagColor[rule.tag]}`}>
            {rule.tag}
          </span>
        </div>
      ))}
    </div>
  );
}

type Capability = {
  label: string;
  detail: string;
  expanded: string;
  preview: string;
  icon: LucideIcon;
  previewElement?: ReactNode;
};

const capabilities: Capability[] = [
  {
    label: 'monitor',
    detail: 'real-time metrics and email/webhook notifications',
    expanded: 'live cpu, memory, gpu, and disk usage for every machine. inline sparkline charts track trends over time. know instantly when something drifts.',
    preview: '/landing-screens/monitor.png',
    icon: Activity,
  },
  {
    label: 'control',
    detail: 'start, stop, or restart any process — with a full API',
    expanded: 'full remote process control across your entire fleet. configure startup sequences, manage dependencies, and auto-restart crashed processes before anyone notices.',
    preview: '/landing-screens/control.png',
    icon: Power,
  },
  {
    label: 'deploy',
    detail: 'push software updates to all machines at once',
    expanded: 'deploy software, configurations, and content to any machine, anywhere. fleet-wide rollouts or targeted single-machine updates — your call.',
    preview: '/landing-screens/preview-deploy.png',
    icon: Rocket,
  },
  {
    label: 'diagnose',
    detail: 'ask cortex why a process crashed, what driver is installed, or which machine just dropped offline.',
    expanded: 'cortex turns plain-english questions into real diagnostic actions across your fleet. bring your own openai or anthropic key.',
    preview: '/landing-screens/preview-diagnose.png',
    icon: Brain,
  },
  {
    label: 'display',
    detail: 'displays that stay put — drift-detected and auto-restored after reboots, driver updates, or accidental changes.',
    expanded: 'owlette captures the windows display topology you want and watches for drift. when a reboot, a driver update, or an accidental change moves a monitor, owlette restores the known-good layout automatically. mosaic-aware.',
    preview: '/landing-screens/preview-displays.png',
    icon: Monitor,
    previewElement: <DisplayPreviewArt />,
  },
  {
    label: 'automate',
    detail: 'scheduled reboots, startup sequences, dependency-aware restarts. set the rules once and stop babysitting.',
    expanded: 'define when machines reboot, the order processes start in, and the dependencies between them. owlette runs the playbook so you don\'t have to.',
    preview: '/landing-screens/preview-automate.png',
    icon: CalendarClock,
    previewElement: <AutomatePreviewArt />,
  },
];

export function UseCaseSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Mirror dragRef.current.dragging as state for the transition toggle in
  // render — React 19 forbids reading ref.current during render. The state
  // only flips on drag start/end (not per-mousemove) so it's cheap.
  const [isDragging, setIsDragging] = useState(false);
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
                    className={`relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5 ${cap.previewElement ? '' : 'cursor-zoom-in'}`}
                    style={cap.previewElement ? undefined : {
                      maskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                      WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                    }}
                    onClick={cap.previewElement ? undefined : () => setLightboxIndex(i)}
                  >
                    {cap.previewElement ? (
                      cap.previewElement
                    ) : (
                      <Image
                        src={cap.preview}
                        alt={`${cap.label} preview`}
                        width={2300}
                        height={1050}
                        className="w-full h-auto"
                        priority
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: 3-column grid (2 rows of 3) with shared preview area below */}
        <div className="hidden lg:block">
          <div className="grid grid-cols-3 gap-6 items-start">
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
            <div className="grid grid-cols-3 gap-6 mt-2">
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

          {/* Preview area — below the grid so cards never shift. supports both image and inline-jsx previews */}
          {(() => {
            const activeCap = openIndex !== null ? capabilities[openIndex] : null;
            const hasInline = activeCap?.previewElement != null;
            return (
              <div
                className={`overflow-hidden transition-all duration-500 ease-out ${activeCap ? 'max-h-[800px] opacity-100 mt-8' : 'max-h-0 opacity-0 mt-0'}`}
              >
                <div
                  className={`relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5 ${hasInline ? '' : 'cursor-zoom-in'}`}
                  style={hasInline ? undefined : {
                    maskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                    maskComposite: 'intersect',
                    WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                    WebkitMaskComposite: 'source-in',
                  }}
                  onClick={hasInline ? undefined : () => openIndex !== null && setLightboxIndex(openIndex)}
                >
                  {hasInline ? (
                    activeCap.previewElement
                  ) : (
                    <div className="relative">
                      {capabilities.map((cap) => (
                        <div
                          key={cap.preview}
                          className="transition-all duration-500 ease-out"
                          style={{
                            opacity: !cap.previewElement && activePreview === cap.preview ? 1 : 0,
                            position: !cap.previewElement && activePreview === cap.preview ? 'relative' : 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: !cap.previewElement && activePreview === cap.preview ? 'translateY(0)' : 'translateY(12px)',
                          }}
                        >
                          {!cap.previewElement && (
                            <Image
                              src={cap.preview}
                              alt={`${cap.label} preview`}
                              width={2300}
                              height={1050}
                              className="w-full h-auto"
                              priority
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
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
            setIsDragging(true);
          }}
          onMouseMove={(e) => {
            if (!dragRef.current.dragging) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.didDrag = true;
            setPan({ x: dragRef.current.startPanX + dx, y: dragRef.current.startPanY + dy });
          }}
          onMouseUp={() => { dragRef.current.dragging = false; setIsDragging(false); }}
          onMouseLeave={() => { dragRef.current.dragging = false; setIsDragging(false); }}
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
              transition: isDragging ? 'none' : 'transform 0.2s ease-out',
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
          <p className="absolute bottom-14 left-1/2 -translate-x-1/2 z-10 text-lg text-white/70 text-center text-balance max-w-2xl mx-auto px-4">
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
