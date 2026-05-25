'use client';

/**
 * Synaptic firing indicator — a hexagonal neuron lattice. Six nodes sit at the
 * vertices of a pointy-top hexagon; a faint web of perimeter + diagonal axons
 * connects them. Cyan signal dots flow around the ring in sequence (a travelling
 * wave) while the nodes fire in a staggered pulse — lively, but composed.
 */
export function SynapticIndicator() {
  const R = 8;
  const C = 12;

  // Pointy-top hexagon vertices, starting at the top and going clockwise.
  const verts = [-90, -30, 30, 90, 150, 210].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: +(C + R * Math.cos(a)).toFixed(2), y: +(C + R * Math.sin(a)).toFixed(2) };
  });

  // Closed perimeter path the signal dots travel along.
  const perimeter = `M ${verts.map((v) => `${v.x} ${v.y}`).join(' L ')} Z`;
  // Long axons across the centre, for the neural-web texture.
  const diagonals = [[0, 3], [1, 4], [2, 5]].map(
    ([a, b]) => `M ${verts[a].x} ${verts[a].y} L ${verts[b].x} ${verts[b].y}`,
  );

  const loop = 2100;          // ms for one full lap around the hexagon
  const nodeCycle = 1260;     // ms for the node firing wave
  const signals = [0, 1, 2].map((i) => (i * loop) / 3); // three dots, evenly chasing

  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 overflow-visible" aria-hidden>
      {/* Axon lattice */}
      <g className="text-foreground" fill="none" stroke="currentColor" strokeLinejoin="round">
        <path d={perimeter} strokeOpacity={0.22} strokeWidth={1} />
        {diagonals.map((d, i) => (
          <path key={`axon-${i}`} d={d} strokeOpacity={0.1} strokeWidth={0.75} />
        ))}
      </g>

      {/* Static fallback for reduced motion — a calm, dimly-lit hexagon. */}
      <g className="hidden motion-reduce:block text-foreground" fill="currentColor">
        {verts.map((v, i) => (
          <circle key={`static-node-${i}`} cx={v.x} cy={v.y} r={1.3} opacity={0.7} />
        ))}
      </g>

      {/* Animated layer — suppressed entirely when the user prefers reduced motion. */}
      <g className="motion-reduce:hidden">
        {/* Neurons — fire in a staggered wave around the ring */}
        <g className="text-foreground" fill="currentColor">
          {verts.map((v, i) => (
            <circle key={`node-${i}`} cx={v.x} cy={v.y} r={1.3}>
              <animate
                attributeName="r"
                values="1.1;2;1.1"
                dur={`${nodeCycle}ms`}
                begin={`${(i * nodeCycle) / 6}ms`}
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.45;1;0.45"
                dur={`${nodeCycle}ms`}
                begin={`${(i * nodeCycle) / 6}ms`}
                repeatCount="indefinite"
              />
            </circle>
          ))}
        </g>

        {/* Signals — cyan dots flowing between neurons, sequenced */}
        <g className="text-accent-cyan" fill="currentColor">
          {signals.map((delay, i) => (
            <circle key={`signal-${i}`} r={1.4} opacity={0}>
              <animateMotion
                dur={`${loop}ms`}
                begin={`${delay}ms`}
                repeatCount="indefinite"
                path={perimeter}
              />
              <animate
                attributeName="opacity"
                values="0;1;1;0.85;0"
                keyTimes="0;0.08;0.5;0.85;1"
                dur={`${loop}ms`}
                begin={`${delay}ms`}
                repeatCount="indefinite"
              />
            </circle>
          ))}
        </g>
      </g>
    </svg>
  );
}
