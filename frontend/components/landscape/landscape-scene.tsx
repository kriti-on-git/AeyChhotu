"use client";

import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useRef } from "react";
import { Sun } from "@/components/landscape/sun";
import { cn } from "@/lib/utils";

/* One page-level scroll listener drives every layer, and each layer only
   animates transform — no layout thrash, no scroll hijacking. */

interface HillLayer {
  id: string;
  path: string;
  /** How far the layer travels across the hero's scroll range. */
  distance: string;
  className: string;
}

const softLayers: HillLayer[] = [
  {
    id: "far",
    distance: "9%",
    className: "absolute inset-x-0 bottom-0 h-[42%] text-tan/50",
    path: "M0 122C214 68 402 112 706 78 1010 44 1204 96 1440 64V320H0Z",
  },
  {
    id: "mid",
    distance: "20%",
    className: "absolute inset-x-0 bottom-0 h-[34%] text-brown/70",
    path: "M0 176C240 128 430 178 720 144 1010 110 1230 166 1440 132V320H0Z",
  },
];

const fullLayers: HillLayer[] = [
  ...softLayers,
  {
    id: "near",
    distance: "34%",
    className: "absolute inset-x-0 bottom-0 h-[26%] text-brown",
    path: "M0 216C300 178 560 232 860 198 1160 164 1300 210 1440 190V320H0Z",
  },
  {
    id: "fore",
    distance: "48%",
    className: "absolute inset-x-0 bottom-0 h-[18%] text-dark-brown",
    path: "M0 262C380 232 720 296 1080 258 1240 242 1360 262 1440 250V320H0Z",
  },
];

function HillLayer({
  layer,
  progress,
  reduce,
}: {
  layer: HillLayer;
  progress: MotionValue<number>;
  reduce: boolean | null;
}) {
  const y = useTransform(progress, [0, 1], ["0%", layer.distance]);

  return (
    <motion.svg
      aria-hidden
      viewBox="0 0 1440 320"
      preserveAspectRatio="none"
      style={reduce ? undefined : { y }}
      className={cn("pointer-events-none block w-full", layer.className)}
    >
      <path d={layer.path} fill="currentColor" />
    </motion.svg>
  );
}

export interface LandscapeSceneProps {
  /** "full" adds the two foreground hills; "soft" keeps an airy horizon. */
  depth?: "full" | "soft";
  className?: string;
}

export function LandscapeScene({ depth = "full", className }: LandscapeSceneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });

  const skyY = useTransform(scrollYProgress, [0, 1], ["0%", "5%"]);
  const sunY = useTransform(scrollYProgress, [0, 1], ["0%", "-24%"]);
  const fade = useTransform(scrollYProgress, [0, 0.85], [1, 0.35]);

  const layers = depth === "full" ? fullLayers : softLayers;

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <motion.div
        style={reduce ? undefined : { y: skyY, opacity: fade }}
        className="absolute inset-0 bg-gradient-to-b from-cream via-beige/80 to-tan/60"
      />

      <motion.div style={reduce ? undefined : { y: sunY }} className="absolute inset-x-0 top-0">
        <Sun className="absolute right-[8%] top-[12%] h-24 w-24 sm:h-32 sm:w-32 lg:h-40 lg:w-40" />
        <Sun
          tone="cream"
          className="absolute top-[19%] right-[14%] h-10 w-10 opacity-40 sm:h-14 sm:w-14"
        />
      </motion.div>

      {layers.map((layer) => (
        <HillLayer key={layer.id} layer={layer} progress={scrollYProgress} reduce={reduce} />
      ))}
    </div>
  );
}
