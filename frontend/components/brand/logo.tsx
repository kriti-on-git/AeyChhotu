import { cn } from "@/lib/utils";

export interface LogoMarkProps {
  className?: string;
  tone?: "default" | "inverse";
}

export function LogoMark({ className, tone = "default" }: LogoMarkProps) {
  const sun = tone === "inverse" ? "var(--color-cream)" : "var(--color-tan)";
  const backHill = tone === "inverse" ? "var(--color-brown)" : "var(--color-brown)";
  const frontHill = tone === "inverse" ? "var(--color-cream)" : "var(--color-dark-brown)";

  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className={cn("size-8", className)}
      fill="none"
    >
      <circle cx="16" cy="12" r="6.5" fill={sun} />
      <path d="M0 24c5.5-5.5 10-2.5 16-6.5S26.5 14 32 19v13H0z" fill={backHill} />
      <path d="M0 31c4-6 9-4.5 14-1.5S28 22 32 27v5H0z" fill={frontHill} />
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
          tone === "inverse" ? "text-cream" : "text-ink",
        )}
      >
        AeyChhotu
        <span className="text-ember">!</span>
      </span>
    </span>
  );
}
