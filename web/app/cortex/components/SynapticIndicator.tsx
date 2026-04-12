'use client';

/**
 * Synaptic firing indicator — a triad of neurons (big, medium, small)
 * exchanging signals bidirectionally along shared axons. Each neuron
 * bobs gently; the whole cluster drifts.
 */
export function SynapticIndicator() {
  const A = { x: 5, y: 18, r: 3.2 };   // big
  const B = { x: 19, y: 15, r: 2.3 };  // medium
  const C = { x: 13, y: 4, r: 1.6 };   // small

  const cycle = 380;
  const d = `${cycle}ms`;

  // 6 pulses — every edge fires in both directions, staggered
  const pulses = [
    { from: A, to: B, delay: 0 },
    { from: B, to: C, delay: 60 },
    { from: C, to: A, delay: 120 },
    { from: B, to: A, delay: 190 },
    { from: C, to: B, delay: 250 },
    { from: A, to: C, delay: 310 },
  ];

  // Per-neuron gentle bob (subtle Y oscillation, varied phase)
  const bobs = [
    { values: '0 0; 0 -0.5; 0 0.3; 0 0', dur: '1.6s' },
    { values: '0 0; 0 0.4; 0 -0.4; 0 0', dur: '1.3s' },
    { values: '0 0; 0 -0.3; 0 0.5; 0 0', dur: '1.9s' },
  ];
  const nodes = [A, B, C];

  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6 overflow-visible text-foreground"
      aria-hidden
    >
      <g>
        {/* Whole-cluster drift */}
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0 0; 0.5 -0.4; -0.4 0.4; 0 0"
          keyTimes="0; 0.33; 0.66; 1"
          dur="2.4s"
          repeatCount="indefinite"
        />

        {/* Axons */}
        {[
          [A, B],
          [B, C],
          [C, A],
        ].map(([p, q], i) => (
          <line
            key={`edge-${i}`}
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
            stroke="currentColor"
            strokeOpacity={0.4}
            strokeWidth={1}
          />
        ))}

        {/* Neurons — each bobs independently */}
        {nodes.map((n, i) => (
          <g key={`node-${i}`}>
            <animateTransform
              attributeName="transform"
              type="translate"
              values={bobs[i].values}
              dur={bobs[i].dur}
              repeatCount="indefinite"
            />
            <circle cx={n.x} cy={n.y} r={n.r} fill="currentColor" />
          </g>
        ))}

        {/* Bidirectional pulses */}
        {pulses.map((p, i) => (
          <circle key={`pulse-${i}`} r={1.6} fill="currentColor" opacity={0}>
            <animateMotion
              dur={d}
              repeatCount="indefinite"
              begin={`${p.delay}ms`}
              path={`M ${p.from.x} ${p.from.y} L ${p.to.x} ${p.to.y}`}
            />
            <animate
              attributeName="opacity"
              values="0;1;1;0"
              keyTimes="0;0.2;0.8;1"
              dur={d}
              begin={`${p.delay}ms`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </g>
    </svg>
  );
}
