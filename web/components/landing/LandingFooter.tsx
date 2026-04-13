import Link from 'next/link';
import { OwletteEyeIcon } from './OwletteEye';

const RANDOM_EMOJIS = [
  "❤️", "💙", "💚", "💛", "💜", "🧡",
  "✨", "🌟", "⭐", "💫", "🌈",
  "🔥", "⚡", "💥", "🚀",
  "🎨", "🎭", "🎪", "🎯",
  "🦉", "🦆", "🐧", "🦜",
  "☕", "🍕", "🌮", "🍔",
  "🎵", "🎸", "🎹", "🎤",
  "💻", "🖥️", "⌨️", "🖱️",
  "🎲", "🎮", "🕹️",
  "🌙", "☀️", "⛅", "🌤️",
];

export function LandingFooter() {
  const emoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];

  return (
    <footer className="border-t border-border/50 bg-card/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6 sm:gap-8">
          {/* Logo and tagline */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0">
            <Link href="/" className="flex items-center gap-1.5">
              <OwletteEyeIcon size={24} className="translate-y-[1px]" />
              <span className="text-base sm:text-lg font-semibold translate-y-[1px]">owlette</span>
            </Link>
            <p className="text-xs sm:text-sm text-muted-foreground ml-[calc(24px+0.375rem)] sm:ml-0">
              attention is all you need
            </p>
          </div>

          {/* Links */}
          <div className="flex flex-wrap justify-center gap-4 sm:gap-8 text-xs sm:text-sm">
            <Link href="/privacy" className="text-muted-foreground hover:text-foreground transition-colors">
              privacy policy
            </Link>
            <Link href="/terms" className="text-muted-foreground hover:text-foreground transition-colors">
              terms of service
            </Link>
            <a href="mailto:support@owlette.app" className="text-muted-foreground hover:text-foreground transition-colors">
              contact
            </a>
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-8 sm:mt-12 pt-6 sm:pt-8 border-t border-border/30 text-center">
          <p className="text-xs sm:text-sm text-muted-foreground flex flex-wrap items-center justify-center gap-1">
            <span>&copy; 2026</span>
            <a href="https://tec.design" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
              TEC
            </a>
            <span className="mx-1 sm:mx-2">&middot;</span>
            <span>made with</span>
            <span className="text-sm sm:text-base leading-none">{emoji}</span>
            <span>in california</span>
            <span className="mx-1 sm:mx-2">&middot;</span>
            <a href="https://github.com/theexperiential/owlette/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
              FSL-1.1-Apache-2.0
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
