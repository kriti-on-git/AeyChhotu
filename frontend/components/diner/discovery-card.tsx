"use client";

import { ArrowRight } from "lucide-react";
import { DishPhoto } from "@/components/diner/dish-photo";
import { Text } from "@/components/ui/text";
import type { MenuItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export interface DiscoveryCardProps {
  /** Cuisine or category name, taken from the data. */
  name: string;
  /** One short line, cuisines only — categories carry just their count. */
  tagline?: string;
  itemCount: number;
  /** A dish from this group, so the card is always photographed from the
      real menu rather than a decorative image. */
  representative: MenuItem;
  onSelect: () => void;
  variant?: "cuisine" | "category";
  className?: string;
}

/* A whole card is one button: the whole surface is the target, the arrow is
   the affordance, and the lift on hover is the only motion. */
export function DiscoveryCard({
  name,
  tagline,
  itemCount,
  representative,
  onSelect,
  variant = "cuisine",
  className,
}: DiscoveryCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-surface p-3 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-[var(--duration-base)] ease-organic hover:-translate-y-1 hover:border-line-strong hover:shadow-md focus-visible:-translate-y-1",
        className,
      )}
    >
      <DishPhoto
        item={representative}
        sizes={
          variant === "cuisine"
            ? "(min-width: 1024px) 22rem, (min-width: 640px) 45vw, 100vw"
            : "(min-width: 1024px) 20rem, (min-width: 640px) 45vw, 100vw"
        }
      />

      <span className="flex flex-1 flex-col p-3 pb-2">
        <span className="font-display text-subheading text-ink">{name}</span>
        {tagline ? (
          <span className="mt-1.5 text-sm leading-relaxed text-ink-muted">{tagline}</span>
        ) : null}

        <span className="mt-auto flex items-center justify-between gap-3 pt-5">
          <Text variant="label" tone="subtle" as="span">
            {itemCount} {itemCount === 1 ? "dish" : "dishes"}
          </Text>
          <ArrowRight
            aria-hidden
            className="size-4 text-ember transition-transform duration-[var(--duration-fast)] group-hover:translate-x-1"
          />
        </span>
      </span>
    </button>
  );
}
