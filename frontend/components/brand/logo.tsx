import Image from "next/image";
import { cn } from "@/lib/utils";

export interface LogoMarkProps {
  className?: string;
  /* Kept so every existing call site keeps compiling: the mark is now the
     brand illustration itself, which needs no tone variant — on the ember
     grounds the cut-out's own white torn edge does the separating. */
  tone?: "default" | "inverse";
}

/* The mark is Mr. Baawarchi — the same cut-out that anchors the hero. One
   brand image everywhere: hero, header, footer, PIN wall, favicons. It sits
   on a rounded ink tile so the white torn edge stays legible on both the
   canvas and the saturated ember grounds. */
export function LogoMark({ className }: LogoMarkProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative isolate inline-flex size-9 shrink-0 items-end justify-center overflow-hidden rounded-lg bg-ink shadow-sm",
        className,
      )}
    >
      <Image
        src="/ref.png"
        alt=""
        width={1672}
        height={941}
        className="w-[118%] max-w-none translate-y-[4%]"
      />
    </span>
  );
}

/* The full cut-out, undressed: for the large decorative watermarks on the
   footer and the closing CTA, where a tile would read as a sticker but the
   chef's silhouette drifting out of frame reads as a mural. */
export function LogoWatermark({ className }: { className?: string }) {
  return (
    <Image
      src="/ref.png"
      alt=""
      aria-hidden
      width={1672}
      height={941}
      className={cn("pointer-events-none select-none", className)}
    />
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
        {/* On the saturated ember ground the ember accent disappears, so the
            inverse lockup uses cream instead. */}
        <span className={tone === "inverse" ? "text-cream" : "text-ember"}>!</span>
      </span>
    </span>
  );
}
