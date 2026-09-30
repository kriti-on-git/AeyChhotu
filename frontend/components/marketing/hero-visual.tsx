"use client";

import Image from "next/image";
import { useRef, type PointerEvent } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";

/* ---------------------------------------------------------------
   Hero visual: the cut-out illustration, large enough that its bottom
   edge lands on the rule that closes the hero section (the negative
   bottom margin cancels the hero's padding, so the chef stands on the
   line). The frame drifts on scroll and leans toward the pointer —
   both disabled for reduced motion; the live-status chips are painted
   from the same tokens the real board uses and bob slowly so a still
   image reads as a live board.
   --------------------------------------------------------------- */

const chipClass =
  "animate-float absolute hidden items-center gap-2 rounded-pill border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-sm sm:flex";

export function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const frameRef = useRef<HTMLDivElement>(null);

  // Scroll parallax is measured against the hero itself, so the drift
  // completes exactly as the section leaves the viewport.
  const { scrollYProgress } = useScroll({
    target: frameRef,
    offset: ["start start", "end start"],
  });
  const scrollDrift = useTransform(scrollYProgress, [0, 1], [0, 72]);
  const scrollTilt = useTransform(scrollYProgress, [0, 1], [0, 3]);

  // Pointer parallax: the pointer position, springed, mapped onto the same
  // 3D pose the old hover used — the rest pose is the -12° lean.
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, { stiffness: 55, damping: 16 });
  const springY = useSpring(pointerY, { stiffness: 55, damping: 16 });
  const poseRotateY = useTransform(springX, [-0.5, 0.5], [-3, -19]);
  const poseRotateX = useTransform(springY, [-0.5, 0.5], [11, 1]);

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((event.clientY - rect.top) / rect.height - 0.5);

    // The ember glow behind the cut-out tracks the pointer, exactly like
    // the spotlight on the expandable cards. Written straight to the node:
    // this fires on every mouse move, far too often for React state.
    const node = frameRef.current;
    if (node) {
      const bounds = node.getBoundingClientRect();
      node.style.setProperty("--mx", `${event.clientX - bounds.left}px`);
      node.style.setProperty("--my", `${event.clientY - bounds.top}px`);
    }
  }

  function handlePointerLeave() {
    pointerX.set(0);
    pointerY.set(0);
  }

  const frame = (
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
        sizes="(min-width: 1024px) 46rem, 100vw"
        className="relative h-auto w-full [filter:drop-shadow(0_34px_44px_rgb(28_21_18/0.26))]"
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
      <div
        ref={frameRef}
        className="group relative mx-auto -mb-20 w-full max-w-xl lg:mx-0 lg:-mb-28 lg:-ml-12 lg:-mr-8 lg:w-[calc(100%+5rem)] lg:max-w-none"
      >
        {frame}
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      className="relative mx-auto -mb-20 w-full max-w-xl lg:mx-0 lg:-mb-28 lg:-ml-12 lg:-mr-8 lg:w-[calc(100%+5rem)] lg:max-w-none"
    >
      <motion.div
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        style={{ y: scrollDrift, rotateX: scrollTilt, transformPerspective: 1500 }}
        className="relative will-change-transform"
      >
        <motion.div
          style={{
            rotateY: poseRotateY,
            rotateX: poseRotateX,
            transformPerspective: 1500,
          }}
          className="relative will-change-transform"
        >
          {frame}
        </motion.div>
      </motion.div>
    </div>
  );
}
