"use client";

import type { ReactNode } from "react";
import { LogoMark } from "@/components/brand/logo";
import { Container } from "@/components/ui/container";
import { cn } from "@/lib/utils";

/* OpsBar — the one compact operations navbar shared by /floor and /kitchen.

   Both surfaces are the same product seen from two places in the room, so the
   bar is deliberately identical: brand lockup, surface name, a live pill, a
   couple of compact metrics and the surface's own actions. It replaced two
   separate page headers that had drifted apart, and it keeps the room's
   numbers in one thin strip instead of a row of statistic cards. */

export interface OpsMetric {
  label: string;
  value: string;
  /** Ember is reserved for the one number that needs a second look. */
  tone?: "default" | "attention";
}

export interface OpsBarProps {
  title: string;
  /** Optional small badge ahead of the title, e.g. the Kitchen tag. */
  prefix?: ReactNode;
  /** Connection indicator — see LiveIndicator. */
  status?: ReactNode;
  metrics?: OpsMetric[];
  actions?: ReactNode;
  className?: string;
}

/** One accent dot + a word: the quietest possible "this board is live". */
export function LiveIndicator({ live = true }: { live?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-line-strong px-2.5 py-1 text-label text-ink-muted uppercase">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-pill",
          live ? "animate-pulse-soft bg-ready" : "bg-pending",
        )}
      />
      {live ? "Live" : "Demo"}
    </span>
  );
}

export function OpsBar({ title, prefix, status, metrics, actions, className }: OpsBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-line-strong bg-surface/95 backdrop-blur-md",
        className,
      )}
    >
      <Container className="flex flex-wrap items-center gap-x-5 gap-y-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <LogoMark className="size-8" />
          <span className="hidden font-display text-lg font-semibold tracking-tight text-ink sm:inline">
            AeyChhotu
          </span>
          <span aria-hidden className="hidden h-5 w-px bg-line-strong sm:block" />
          {prefix}
          <h1 className="truncate font-display text-subheading leading-none text-ink">{title}</h1>
          {status}
        </div>

        {metrics && metrics.length > 0 ? (
          <dl className="hidden items-center gap-6 lg:flex">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex flex-col leading-none">
                <dt className="text-label text-ink-subtle uppercase">{metric.label}</dt>
                <dd
                  className={cn(
                    "mt-1 font-display text-lg font-semibold tabular-nums",
                    metric.tone === "attention" ? "text-ember" : "text-ink",
                  )}
                >
                  {metric.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      </Container>
    </header>
  );
}
