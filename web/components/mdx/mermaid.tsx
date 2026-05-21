"use client";

import { use, useId, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

/**
 * Renders a Mermaid diagram from a ```mermaid code fence, themed to match the
 * docs (Geist typography + the Fumadocs/site color tokens) so diagrams read as
 * part of the page, not a foreign embed.
 *
 * The `remarkMdxMermaid` plugin (wired in source.config.ts) rewrites every
 * ```mermaid fence into `<Mermaid chart="..." />`, so this component owns all
 * diagram rendering. Mermaid is imported lazily (React `use` + a module-level
 * promise cache) so its bundle only loads on pages that contain a diagram, and
 * rendered SVG is cached per chart+theme so toggling the theme doesn't re-render.
 *
 * Theming notes:
 *  - We resolve the live CSS custom properties at render time (rather than
 *    hardcoding colors) so the diagram tracks the active theme. The tokens are
 *    `oklch(...)`, which Mermaid's color lib (khroma) can't parse, so each is
 *    normalized to hex via a canvas 2d context first.
 *  - We pass an explicit `fontFamily` (Geist) and await `document.fonts.ready`
 *    before rendering. Mermaid sizes each node from a text measurement; if the
 *    measure font and render font differ (e.g. the upstream `fontFamily:
 *    "inherit"`, or a web font that loads late), boxes come out ~1 glyph too
 *    narrow and clip the last character. Same font + loaded font = no clipping.
 */
const subscribe = () => () => {};

function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export function Mermaid({ chart }: { chart: string }) {
  if (!useIsClient()) return null;
  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

/**
 * Resolve the site's design tokens into hex colors + a font stack the diagram
 * can use. Reads from the docs layout element so it inherits the active theme's
 * cascade; falls back to <html>. Canvas normalizes any CSS color (incl oklch)
 * to "#rrggbb"; if a token is missing/unparseable it falls back to `fallback`.
 */
function resolveTokens() {
  const root = document.getElementById("nd-docs-layout") ?? document.documentElement;
  const cs = getComputedStyle(root);
  const ctx = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });

  // Rasterize the color to a 1px sRGB pixel and read the bytes back as
  // "#rrggbb". We can't just read `ctx.fillStyle` — for an oklch/wide-gamut
  // input the canvas serializes it back as `lab(...)`/`color(...)`, which
  // Mermaid's color lib (khroma) rejects. Drawing forces a concrete sRGB value.
  const hex = (value: string, fallback: string): string => {
    const v = value.trim();
    if (!v || !ctx) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";
    try {
      ctx.fillStyle = v;
    } catch {
      return fallback;
    }
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  };
  const color = (name: string, fallback: string) =>
    hex(cs.getPropertyValue(name), fallback);

  const fontGeist = cs.getPropertyValue("--font-geist").trim();
  return {
    background: color("--background", "#0b1020"),
    foreground: color("--foreground", "#f7f8f8"),
    card: color("--card", "#1c2333"),
    border: color("--border", "#3a4663"),
    muted: color("--muted", "#262f44"),
    mutedForeground: color("--muted-foreground", "#9aa6c0"),
    accent: color("--accent-cyan", "#36c5d6"),
    accentMuted: color("--accent-cyan-muted", "#2a6e78"),
    fontFamily: `${fontGeist ? `${fontGeist}, ` : ""}ui-sans-serif, system-ui, sans-serif`,
  };
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(
    cachePromise("mermaid", () => import("mermaid")),
  );

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, async () => {
      // Wait for the web font so node sizing is measured with the render font.
      if (document.fonts?.ready) await document.fonts.ready;
      const t = resolveTokens();

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        fontFamily: t.fontFamily,
        themeCSS: "margin: 1.25rem auto 0;",
        // Extra rank spacing keeps the labels on antiparallel edges (e.g.
        // RUNNING<->KILLED) from overlapping; basis curves read more softly.
        flowchart: { curve: "basis", nodeSpacing: 60, rankSpacing: 80 },
        themeVariables: {
          darkMode: resolvedTheme !== "light",
          fontFamily: t.fontFamily,
          fontSize: "15px",
          background: t.background,
          // shared node palette (flowchart + state)
          primaryColor: t.card,
          primaryBorderColor: t.border,
          primaryTextColor: t.foreground,
          secondaryColor: t.muted,
          tertiaryColor: t.background,
          mainBkg: t.card,
          nodeBorder: t.border,
          nodeTextColor: t.foreground,
          clusterBkg: t.muted,
          clusterBorder: t.border,
          lineColor: t.mutedForeground,
          textColor: t.foreground,
          titleColor: t.foreground,
          edgeLabelBackground: t.background,
          // state diagram specifics
          labelColor: t.foreground,
          // sequence diagram specifics
          actorBkg: t.card,
          actorBorder: t.border,
          actorTextColor: t.foreground,
          actorLineColor: t.border,
          signalColor: t.mutedForeground,
          signalTextColor: t.foreground,
          labelBoxBkgColor: t.card,
          labelBoxBorderColor: t.border,
          labelTextColor: t.foreground,
          loopTextColor: t.foreground,
          noteBkgColor: t.muted,
          noteTextColor: t.foreground,
          noteBorderColor: t.border,
          activationBkgColor: t.muted,
          activationBorderColor: t.border,
          sequenceNumberColor: t.background,
        },
      });

      // useId() returns ":r0:"-style values; mermaid feeds the id into an
      // internal querySelector, where a leading colon is an invalid selector
      // and throws — so strip them.
      return mermaid.render(id.replaceAll(":", ""), chart.replaceAll("\\n", "\n"));
    }),
  );

  return (
    <div
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
