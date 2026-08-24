/**
 * TridantSystem — the inline "a tridant system" brand mark.
 *
 * "tridant" is set in `foreground/80` and is the only part that reacts to hover
 * (brightening to the cyan accent); "a" / "system" inherit the host text colour, so the
 * mark adapts to any context. Style colour / size via `className`.
 *
 * Spelling: the company is "tridant" (no "e").
 */

interface TridantSystemProps {
  /** Link target for the mark. Pass `null` to render as static (non-linked) text. */
  href?: string | null;
  className?: string;
}

export function TridantSystem({ href = 'https://tridant.io', className = '' }: TridantSystemProps) {
  const label = (
    <>
      a <span className="text-foreground/80 transition-colors group-hover:text-accent-cyan">tridant</span> system
    </>
  );

  if (!href) {
    return <span className={className}>{label}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`group ${className}`}
    >
      {label}
    </a>
  );
}
