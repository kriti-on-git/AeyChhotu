import { cn } from "@/lib/utils";

export type OrganicShapeVariant = "arch" | "blob" | "pebble";

const paths: Record<OrganicShapeVariant, { viewBox: string; d: string }> = {
  arch: {
    viewBox: "0 0 100 100",
    d: "M0 100V46C0 20.6 22.4 0 50 0s50 20.6 50 46v54z",
  },
  blob: {
    viewBox: "0 0 100 100",
    d: "M52 2c24 0 46 16 46 40 0 22-14 32-30 42-14 9-30 16-46 10C6 88-2 70 1 50 5 26 24 2 52 2z",
  },
  pebble: {
    viewBox: "0 0 100 100",
    d: "M50 4c26 0 48 18 48 44S74 96 48 96 2 78 2 52 24 4 50 4z",
  },
};

export interface OrganicShapeProps {
  variant?: OrganicShapeVariant;
  className?: string;
}

export function OrganicShape({ variant = "blob", className }: OrganicShapeProps) {
  const shape = paths[variant];

  return (
    <svg
      aria-hidden
      viewBox={shape.viewBox}
      preserveAspectRatio="none"
      className={cn("pointer-events-none block fill-current", className)}
    >
      <path d={shape.d} />
    </svg>
  );
}
