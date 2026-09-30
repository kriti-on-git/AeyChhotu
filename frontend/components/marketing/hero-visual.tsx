"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";

/* ---------------------------------------------------------------
   Hero visual: the cut-out illustration sized to 75% of the hero
   section's full height (measured from the live section, capped at
   72% of the viewport so it never buries the headline on narrow
   laptops). From lg up the frame is absolutely positioned against
   the hero's Container: bottom-0 plants its bottom edge exactly on
   the rule that closes the section, and -left-20 slides it into the
   page gutter, under the copy column (whose z-10 + canvas veil keep
   the headline readable).

   The frame itself carries the transforms — scroll drift plus pointer
   lean on one element — because a transformed wrapper between this
   frame and its positioned ancestor would silently become the
   containing block and break the border anchoring. All motion is
   disabled for reduced motion.
   --------------------------------------------------------------- */

const ASPECT = 1672 / 941;

const chipClass =
  "animate-float absolute hidden items-center gap-2 rounded-pill border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-sm sm:flex";

const frameClass =
  "group relative mx-auto -mb-20 w-full max-w-xl will-change-transform lg:absolute lg:bottom-0 lg:-left-20 lg:mb-0 lg:ml-0 lg:max-w-none lg:w-auto";

export function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // 75% of the hero section's height, measured live: the section is the
  // truth (its height is whatever the copy column needs), and the image
  // follows it. Re-measured on resize; below the lg breakpoint the image
  // falls back to plain in-flow sizing.
  useEffect(() => {
    const section = rootRef.current?.closest("section");
    if (!section) return;

    const compute = () => {
      if (window.innerWidth < 1024) {
        setSize(null);
        return;
      }
      const targetHeight = section.offsetHeight * 0.75;
      // 72vw keeps a slim gutter and a sliver of air at the right edge on
      // the narrowest laptops while still letting the 75% height through.
      const width = Math.min(targetHeight * ASPECT, window.innerWidth * 0.72);
      setSize({ w: Math.round(width), h: Math.round(width / ASPECT) });
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(section);
    window.addEventListener("resize", compute);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, []);

  // Scroll parallax rides the page scroll: the drift completes across the
  // hero's scroll-through (the section is ~781px tall on laptops, and the
  // frame is absolutely positioned, so targeting the root's own box would
  // measure a zero-height element).
  const { scrollY } = useScroll();
  const scrollDrift = useTransform(scrollY, [0, 900], [0, 72]);
  const scrollTilt = useTransform(scrollY, [0, 900], [0, 3]);

  // Pointer parallax: the pointer position, springed, mapped around the
  // -12° rest lean. Scroll tilt and pointer tilt are summed on the
  // frame's single transform.
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, { stiffness: 55, damping: 16 });
  const springY = useSpring(pointerY, { stiffness: 55, damping: 16 });
  const poseRotateY = useTransform(springX, [-0.5, 0.5], [-3, -19]);
  const poseRotateX = useTransform(springY, [-0.5, 0.5], [11, 1]);
  const tilt = useTransform<number, number>(
    [scrollTilt, poseRotateX],
    ([scroll = 0, pose = 0]) => scroll + pose,
  );

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((event.clientY - rect.top) / rect.height - 0.5);

    // The ember glow behind the cut-out tracks the pointer, exactly like
    // the spotlight on the expandable cards. Written straight to the node:
    // this fires on every mouse move, far too often for React state.
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  }

  function handlePointerLeave() {
    pointerX.set(0);
    pointerY.set(0);
  }

  const frameBody = (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-8 top-1/4 h-3/4 rounded-pill bg-ember/8 blur-3xl"
      />
      {/* Pointer-following ember glow, the same treatment the info cards
          use — it only appears while the pointer is over the hero. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[var(--duration-base)] group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(480px circle at var(--mx, 50%) var(--my, 45%), color-mix(in srgb, var(--color-ember) 18%, transparent), transparent 72%)",
        }}
      />
      <Image
        src="/ref.png"
        alt="Mr. Baawarchi watching live tickets on the kitchen tablet"
        width={1672}
        height={941}
        priority
        sizes="(min-width: 1024px) 72vw, 100vw"
        className="relative h-auto w-full [filter:drop-shadow(0_34px_44px_rgb(28_21_18/0.26))] lg:h-full lg:w-auto"
      />

      <span className={`${chipClass} top-1 left-0`}>
        <span aria-hidden className="size-2 rounded-pill bg-ready" />
        Ticket ready
      </span>
      <span className={`${chipClass} right-2 bottom-10 [animation-delay:-2.6s]`}>
        <span aria-hidden className="size-2 rounded-pill bg-preparing" />
        3 tables live
      </span>
    </>
  );

  // Reduced motion: a large, still image — no drift, no lean, no bob
  // (the global reduced-motion rule also freezes the chip keyframes).
  if (reduceMotion) {
    return (
      <div ref={rootRef} className="w-full">
        <div className={frameClass} style={size ? { width: size.w, height: size.h } : undefined}>
          {frameBody}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full">
      <motion.div
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className={frameClass}
        style={{
          y: scrollDrift,
          rotateX: tilt,
          rotateY: poseRotateY,
          transformPerspective: 1500,
          width: size?.w,
          height: size?.h,
        }}
      >
        {frameBody}
      </motion.div>
    </div>
  );
}
