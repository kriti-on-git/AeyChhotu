import { cn } from "@/lib/utils";

export interface SectionDividerProps {
  /** Text-colour utility applied to the divider so it matches the next surface. */
  fill?: string;
  flip?: boolean;
  className?: string;
}

export function SectionDivider({
  fill = "text-surface",
  flip = false,
  className,
}: SectionDividerProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none -mb-px w-full overflow-hidden leading-none",
        flip && "rotate-180",
        className,
      )}
    >
      <svg
        viewBox="0 0 1440 120"
        preserveAspectRatio="none"
        className={cn("h-14 w-full sm:h-20 lg:h-24", fill)}
      >
        <path
          fill="currentColor"
          d="M0 120V78c150-38 286-52 430-34 168 21 300 44 470 24 148-18 300-34 540-16v68z"
        />
      </svg>
    </div>
  );
}
