"use client";

import type { ReactNode } from "react";
import { LogoMark } from "@/components/brand/logo";
import { Container } from "@/components/ui/container";
import { cn } from "@/lib/utils";

/* OpsBar — the one compact operations navbar shared by /floor and /kitchen.

   Deliberately reduced to three things: the brand lockup, the surface's own
   name (a badge or a heading), and icon-only actions. The room's numbers and
   connection state used to live here as well; they moved down into the floor's
   summary, so the bar is now the same thin strip on both surfaces and never
   repeats a figure the page already shows. Every action is an IconButton with
   an accessible label, so the one-line bar stays legible from across a room. */

export interface OpsBarProps {
  /** Surface name. Omitted on the kitchen, which its badge identifies. */
  title?: string;
  /** Small badge ahead of the title, e.g. the Kitchen tag. */
  prefix?: ReactNode;
  /** Icon-only actions — see IconButton. */
  actions?: ReactNode;
  className?: string;
}

export function OpsBar({ title, prefix, actions, className }: OpsBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-line-strong bg-surface/95 backdrop-blur-md",
        className,
      )}
    >
      <Container className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <LogoMark className="size-8" />
          <span className="hidden font-display text-lg font-semibold tracking-tight text-ink sm:inline">
            AeyChhotu
          </span>
          <span aria-hidden className="hidden h-5 w-px bg-line-strong sm:block" />
          {prefix}
          {title ? (
            <h1 className="truncate font-display text-subheading leading-none text-ink">{title}</h1>
          ) : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      </Container>
    </header>
  );
}
