import type { ElementType, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type CardTone = "surface" | "canvas" | "outline" | "ink";

const tones: Record<CardTone, string> = {
  surface: "bg-surface border-line shadow-sm",
  canvas: "bg-canvas border-line shadow-sm",
  outline: "bg-transparent border-line-strong",
  ink: "bg-dark-brown border-dark-brown text-cream shadow-md",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  interactive?: boolean;
  as?: ElementType;
}

export function Card({
  tone = "surface",
  interactive = false,
  as: Component = "div",
  className,
  ...props
}: CardProps) {
  return (
    <Component
      className={cn(
        "relative rounded-lg border p-6",
        tones[tone],
        interactive &&
          "transition-[transform,box-shadow] duration-[var(--duration-base)] ease-organic hover:-translate-y-1 hover:shadow-md focus-within:-translate-y-1 focus-within:shadow-md",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
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
  return (
    <div className={cn("mt-5 flex items-center gap-3 pt-5", className)} {...props} />
  );
}
