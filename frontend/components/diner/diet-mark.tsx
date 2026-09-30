import { cn } from "@/lib/utils";

/* The veg / non-veg mark, using the square-with-a-dot convention diners
   actually recognise on an Indian menu rather than a bare coloured dot that
   reads as a legend you have to learn first. Shared by every dish surface. */
export function DietMark({ vegetarian, className }: { vegetarian: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={vegetarian ? "Vegetarian" : "Non-vegetarian"}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[3px] border-2 bg-canvas",
        vegetarian ? "border-ready" : "border-alert",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-pill", vegetarian ? "bg-ready" : "bg-alert")} />
    </span>
  );
}
