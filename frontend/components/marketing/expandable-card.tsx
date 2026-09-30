"use client";

import { ChevronDown } from "lucide-react";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* A card that keeps its default state to a title and one line, and reveals
   the rest when the reader taps it. The whole header is the toggle, so the
   target is large on touch, and the detail is real DOM (not a tooltip) so it
   is selectable and reachable by keyboard.
   
   The `icon` is an element rather than a component reference on purpose: this
   is a client component, and a Lucide component reference cannot cross the
   server boundary. */
export interface ExpandableCardProps {
  icon?: ReactNode;
  /** Small index or role label above the title. */
  meta?: string;
  title: string;
  /** Short always-visible line under the title. */
  teaser?: string;
  /** Revealed on tap/click. */
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function ExpandableCard({
  icon,
  meta,
  title,
  teaser,
  children,
  defaultOpen = false,
  className,
}: ExpandableCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const cardRef = useRef<HTMLDivElement>(null);

  /* Feed the pointer position into the spotlight so the glow tracks the
     cursor. Written straight to the node: this changes on every mouse move,
     far too often to route through React state. */
  function trackPointer(event: PointerEvent<HTMLDivElement>) {
    const node = cardRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    node.style.setProperty("--my", `${event.clientY - rect.top}px`);
  }

  return (
    <div
      ref={cardRef}
      onPointerMove={trackPointer}
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-sm",
        "transition-[transform,box-shadow,border-color] duration-[var(--duration-base)] ease-organic",
        "hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md",
        open && "border-line-strong shadow-md",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[var(--duration-base)] group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(220px circle at var(--mx, 50%) var(--my, 0%), color-mix(in srgb, var(--color-ember) 15%, transparent), transparent 72%)",
        }}
      />

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="relative flex w-full cursor-pointer items-start gap-4 p-5 text-left"
      >
        {icon ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-ember-soft text-ember transition-colors duration-[var(--duration-base)] group-hover:bg-ember group-hover:text-on-ember">
            {icon}
          </span>
        ) : null}

        <span className="flex flex-1 flex-col">
          {meta ? (
            <span className="font-display text-xs font-semibold tracking-[0.18em] text-ink-subtle uppercase">
              {meta}
            </span>
          ) : null}

          <span
            role="heading"
            aria-level={3}
            className="font-display text-subheading font-semibold text-ink"
          >
            {title}
          </span>

          {teaser ? (
            <span className="mt-1.5 block text-sm leading-relaxed text-ink-muted">{teaser}</span>
          ) : null}
        </span>

        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1.5 size-4 shrink-0 text-ink-subtle transition-transform duration-[var(--duration-base)] ease-organic",
            open && "rotate-180 text-ember",
          )}
        />
      </button>

      {/* 0fr → 1fr animates to the content's natural height, so the card does
          not need a magic max-height. */}
      <div
        className={cn(
          "relative grid transition-[grid-template-rows,opacity] duration-[var(--duration-base)] ease-organic",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-5 pb-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
