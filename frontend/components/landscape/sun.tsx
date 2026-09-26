import { cn } from "@/lib/utils";

export interface SunProps {
  className?: string;
  tone?: "tan" | "cream";
}

export function Sun({ className, tone = "tan" }: SunProps) {
  return (
    <span
      className={cn(
        "shadow-glow block rounded-pill",
        tone === "tan" ? "bg-tan" : "bg-cream",
        className,
      )}
    />
  );
}
