"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";

const RANDOM_EMOJIS = [
  "❤️", "💙", "💚", "💛", "💜", "🧡", // hearts
  "✨", "🌟", "⭐", "💫", "🌈", // sparkles
  "🔥", "⚡", "💥", "🚀", // energy
  "🎨", "🎭", "🎪", "🎯", // creative
  "🦉", "🦆", "🐧", "🦜", // birds (owlette!)
  "☕", "🍕", "🌮", "🍔", // food
  "🎵", "🎸", "🎹", "🎤", // music
  "💻", "🖥️", "⌨️", "🖱️", // tech
  "🎲", "🎮", "🕹️", // games
  "🌙", "☀️", "⛅", "🌤️", // weather
  "🤪", "😜", "😝", "🥴", "😵‍💫", "🤡", "🥳", "😎", // goofy faces
  "💨", "🌪️", "💩", "🧻", // wind/farts
  "🦄", "🦖", "🦕", "🐙", "🦑", "🦞", // silly animals
  "🍌", "🥒", "🌽", "🍆", "🥑", "🧀", // funny food
  "🎃", "👻", "💀", "👽", "🤖", "🛸", // spooky/weird
  "🦷", "👀", "👁️", "🧠", "🦴", // body parts (weird!)
  "💯", "🆒", "🤙", "🤘", "✌️", "🫰", // gestures
  "🪐", "🌮", "🦥", "🐢", "🐌", // random fun
];

export function Footer() {
  const [emoji, setEmoji] = useState("❤️");
  const pathname = usePathname();

  useEffect(() => {
    // Pick a random emoji whenever the route changes
    const randomEmoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];
    setEmoji(randomEmoji);
  }, [pathname]);

  // Hide footer on admin pages (admin panel has its own footer)
  // Hide footer on landing page (has its own LandingFooter)
  if (pathname?.startsWith('/admin') || pathname === '/' || pathname?.startsWith('/cortex')) {
    return null;
  }

  return (
    <footer className="fixed bottom-0 left-0 right-0 w-full bg-gradient-to-t from-background via-background/95 to-transparent pt-8 pb-6 z-10 pointer-events-none">
      <div className="container mx-auto px-4 pointer-events-auto">
        <p className="text-center text-xs text-muted-foreground flex items-center justify-center gap-1">
          <span>made with</span>
          <span className="text-base leading-none -translate-y-0.4">{emoji}</span>
          <span>in california by</span>
          <Link
            href="https://tec.design"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-muted-foreground hover:underline transition-colors"
          >
            TEC
          </Link>
        </p>
        <p className="text-center text-xs text-muted-foreground mt-2 flex items-center justify-center gap-2">
          <Link
            href="/privacy"
            className="hover:text-muted-foreground transition-colors"
          >
            privacy
          </Link>
          <span>&middot;</span>
          <Link
            href="/terms"
            className="hover:text-muted-foreground transition-colors"
          >
            terms
          </Link>
          <span>&middot;</span>
          <Link
            href="https://github.com/theexperiential/Owlette"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-muted-foreground transition-colors"
          >
            source (FSL-1.1-Apache-2.0)
          </Link>
        </p>
      </div>
    </footer>
  );
}
