"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/* Desktop-only pool of shadow under the hero's content. It echoes the
   cursor-tracked spotlight on the "What gaps are we bridging?" cards: a soft
   ember-warm fall of light that follows the pointer and settles back out when
   it leaves. It listens on its parent section instead of wrapping the hero, so
   the landing page stays a server component and the hero's own markup is left
   alone.

   Nothing is written through React state — the pointer only updates two CSS
   custom properties on this node, so there is no render per mouse move. */
export function HeroPointerShadow({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    const host = node?.parentElement;
    if (!node || !host) return;

    // The effect is a laptop nicety: leave phones and tablets untouched.
    const media = window.matchMedia("(min-width: 64rem)");
    if (!media.matches) return;

    const move = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      node.style.setProperty("--hx", `${((event.clientX - rect.left) / rect.width) * 100}%`);
      node.style.setProperty("--hy", `${((event.clientY - rect.top) / rect.height) * 100}%`);
      node.style.setProperty("--hi", "1");
    };
    const leave = () => node.style.setProperty("--hi", "0");

    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 hidden lg:block", className)}
      style={{
        background:
          "radial-gradient(34rem circle at var(--hx, 42%) var(--hy, 46%), color-mix(in srgb, var(--color-ember) 16%, transparent), color-mix(in srgb, var(--color-ember) 8%, transparent) 34%, transparent 72%)",
        opacity: "var(--hi, 0)",
        transition: "opacity 520ms var(--ease-gentle)",
      }}
    />
  );
}
