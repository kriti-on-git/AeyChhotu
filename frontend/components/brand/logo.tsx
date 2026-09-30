import { cn } from "@/lib/utils";

export interface LogoMarkProps {
  className?: string;
  tone?: "default" | "inverse";
}

/* A cloche read as an arch: food service and a bridge between the floor and
   the kitchen in one glyph. A solid tinted tile replaces the old
   multi-path landscape illustration, which read as clip art rather than a
   product mark. */
export function LogoMark({ className, tone = "default" }: LogoMarkProps) {
  const tile = tone === "inverse" ? "var(--color-cream)" : "var(--color-ember)";
  const glyph = tone === "inverse" ? "var(--color-dark-brown)" : "var(--color-on-ember)";

  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8", className)}>
      <rect width="32" height="32" rx="9" fill={tile} />
      <g
        stroke={glyph}
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M5.5 22.5h21" />
        <path d="M8.5 22.5a7.5 7.5 0 0115 0" />
      </g>
      <circle cx="16" cy="12.6" r="2.1" fill={glyph} />
    </svg>
  );
}

export interface LogoProps {
  className?: string;
  tone?: "default" | "inverse";
  showMark?: boolean;
}

export function Logo({ className, tone = "default", showMark = true }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      {showMark ? <LogoMark tone={tone} /> : null}
      <span
        className={cn(
          "font-display text-xl font-semibold tracking-tight",
          tone === "inverse" ? "text-ink-inverse" : "text-ink",
        )}
      >
        AeyChhotu
        <span className="text-ember">!</span>
      </span>
    </span>
  );
}
