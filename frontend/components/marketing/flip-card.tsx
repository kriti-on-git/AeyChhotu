"use client";

import { RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* A card that flips over on tap: the front carries the icon and title, the
   back reveals the body. Both faces are real DOM (not a 3D trick over hidden
   text), and the flip is a button, so keyboard and screen-reader users get
   the same reveal — aria-expanded announces the state, and the aria-hidden
   face is kept out of the tree while face-down.

   `icon` is an element rather than a component reference on purpose: this is
   a client component, and a Lucide reference cannot cross the server
   boundary. */
export interface FlipCardProps {
  icon?: ReactNode;
  title: string;
  /** Always-visible line on the front face. */
  teaser?: string;
  /** Revealed on the back face. */
  children: ReactNode;
  className?: string;
}

export function FlipCard({ icon, title, teaser, children, className }: FlipCardProps) {
  const [flipped, setFlipped] = useState(false);

  return (
    <div className={cn("h-full [perspective:1200px]", className)}>
      <button
        type="button"
        onClick={() => setFlipped((value) => !value)}
        aria-expanded={flipped}
        aria-label={flipped ? `Hide details: ${title}` : `Reveal details: ${title}`}
        className="group relative block h-full min-h-44 w-full cursor-pointer text-left"
      >
        <span
          aria-hidden={flipped}
          className={cn(
            "absolute inset-0 flex flex-col rounded-lg border border-line bg-surface p-5 shadow-sm",
            "transition-[transform,opacity,box-shadow] duration-[var(--duration-slower)] ease-organic",
            "group-hover:shadow-md",
            flipped ? "pointer-events-none opacity-0 [transform:rotateY(180deg)]" : "[transform:rotateY(0deg)]",
          )}
        >
          {icon ? (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-ember-soft text-ember transition-colors duration-[var(--duration-base)] group-hover:bg-ember group-hover:text-on-ember">
              {icon}
            </span>
          ) : null}

          <span
            role="heading"
            aria-level={3}
            className="mt-4 block font-display text-subheading font-semibold text-ink"
          >
            {title}
          </span>

          {teaser ? (
            <span className="mt-1.5 block text-sm leading-relaxed text-ink-muted">{teaser}</span>
          ) : null}

          <span className="mt-auto flex items-center gap-1.5 pt-3 text-label font-semibold tracking-[0.08em] text-ember uppercase">
            <RotateCw aria-hidden className="size-3.5" />
            Tap to reveal
          </span>
        </span>

        <span
          aria-hidden={!flipped}
          className={cn(
            "absolute inset-0 flex flex-col rounded-lg border-2 border-ember bg-ember-soft p-5 shadow-md",
            "transition-[transform,opacity,box-shadow] duration-[var(--duration-slower)] ease-organic",
            flipped ? "[transform:rotateY(0deg)]" : "pointer-events-none opacity-0 [transform:rotateY(-180deg)]",
          )}
        >
          <span className="flex items-center justify-between gap-3">
            <span
              role="heading"
              aria-level={3}
              className="font-display text-base font-semibold text-ember-strong"
            >
              {title}
            </span>
            {icon ? <span className="shrink-0 text-ember">{icon}</span> : null}
          </span>

          <span className="mt-3 block overflow-y-auto text-sm leading-relaxed text-ink">
            {children}
          </span>

          <span className="mt-auto flex items-center gap-1.5 pt-3 text-label font-semibold tracking-[0.08em] text-ember uppercase">
            <RotateCw aria-hidden className="size-3.5" />
            Tap to flip back
          </span>
        </span>
      </button>
    </div>
  );
}
