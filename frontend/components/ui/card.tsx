import type { ElementType, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type CardTone = "surface" | "canvas" | "sunken" | "outline" | "ink" | "accent";

const tones: Record<CardTone, string> = {
  /* White on the near-white canvas: the card is the only thing that
     lifts, which is what gives the page a reading order. */
  surface: "bg-surface border-line shadow-sm",
  canvas: "bg-canvas border-line",
  sunken: "bg-surface-sunken border-line",
  outline: "bg-transparent border-line-strong",
  ink: "bg-ink border-ink text-ink-inverse shadow-md",
  accent: "bg-ember-soft border-ember/25",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  interactive?: boolean;
  /** Adds a hairline accent rule along the top edge — used to mark the
      lead card in a grid without shouting. */
  marked?: boolean;
  as?: ElementType;
}

export function Card({
  tone = "surface",
  interactive = false,
  marked = false,
  as: Component = "div",
  className,
  children,
  ...props
}: CardProps) {
  return (
    <Component
      className={cn(
        "relative overflow-hidden rounded-lg border p-6",
        tones[tone],
        interactive &&
          "transition-[transform,box-shadow,border-color] duration-[var(--duration-base)] ease-organic hover:-translate-y-1 hover:border-line-strong hover:shadow-md focus-within:-translate-y-1 focus-within:shadow-md",
        className,
      )}
      {...props}
    >
      {marked ? (
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-ember" />
      ) : null}
      {children}
    </Component>
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("font-display text-subheading font-semibold text-current", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm leading-relaxed text-ink-muted", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-5 flex items-center gap-3 pt-5", className)} {...props} />;
}
