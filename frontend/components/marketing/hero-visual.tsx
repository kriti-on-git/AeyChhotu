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
   Hero visual: ONE composition.

   .hero-visual-wrapper holds four things and nothing else — the
   ambient light layer, the cut-out server, and the two status pills.
   The pills are absolutely positioned against the wrapper, not the
   page, so they orbit the illustration and cannot drift into the
   headline at any width.

   The lighting rule this file exists to keep: the pointer moves the
   GLOW LAYER, never the image's own pixels. The image carries no
   shadow, no filter and no glow — a box-shaped treatment on a PNG is
   visible as a rectangle around the subject, and the source art is a
   wide canvas with a narrow figure inside it, so that rectangle would
   sit a long way from anything you can actually see. The crop that
   makes the wrapper hug the figure, and the reasoning behind it, live
   in app/globals.css next to the classes.

   Desktop only (see useIsDesktop): the composition also drifts deeper
   on scroll (parallax) and leans toward the cursor in 3D. Phones keep
   the original, gentler drift and no tilt.

   Interaction cost: one pointer handler. It writes two numbers to the
   wrapper as CSS custom properties and two motion values, so there is
   no React re-render; .hero-glow eases into whatever it is handed with
   a transition of its own, and the tilt is springed. Moving away writes
   the resting values back and the light settles there.
   --------------------------------------------------------------- */

export function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const isDesktop = useIsDesktop();
  // The 3D tilt is a laptop demonstration only; the glow behaves as it always
  // did at every width.
  const interactive = isDesktop && !reduceMotion;
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Springed pointer position, so the tilt leans toward the cursor and eases
  // back to rest instead of snapping.
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, { stiffness: 60, damping: 16 });
  const springY = useSpring(pointerY, { stiffness: 60, damping: 16 });
  const rotateY = useTransform(springX, [-0.5, 0.5], [-9, 9]);
  const rotateX = useTransform(springY, [-0.5, 0.5], [7, -7]);

  /* The only thing the pointer is allowed to touch: the glow's offsets,
     normalised to -1…1 from the centre of the visual. */
  function pointGlowAt(x: number, y: number) {
    const node = wrapperRef.current;
    if (!node) return;
    node.style.setProperty("--gx", x.toFixed(3));
    node.style.setProperty("--gy", y.toFixed(3));
    node.style.setProperty("--gi", Math.min(1, Math.hypot(x, y)).toFixed(3));
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width - 0.5;
    const ny = (event.clientY - rect.top) / rect.height - 0.5;

    if (interactive) {
      pointerX.set(nx);
      pointerY.set(ny);
    }

    if (reduceMotion) return;
    pointGlowAt(nx * 2, ny * 2);
  }

  function handlePointerLeave() {
    if (interactive) {
      pointerX.set(0);
      pointerY.set(0);
    }

    if (reduceMotion) return;
    pointGlowAt(0, 0);
  }

  // The parallax: a vertical drift across the hero's scroll-through, deeper on
  // desktop where the artwork is large enough for the travel to read.
  const { scrollY } = useScroll();
  const drift = useTransform(scrollY, [0, 900], [0, interactive ? 96 : 48]);

  const body = (
    <>
      {/* 1 — the ambient field. Everything you can see of the "glow" is this
          one layer, sitting behind the art and drifting with the pointer. */}
      <div aria-hidden className="hero-glow" />

      {/* 2 — the server. Transparent, untouched, no shadow of its own. */}
      <Image
        src="/ref.png"
        alt="Mr. Baawarchi watching live tickets on the kitchen tablet"
        width={1672}
        height={941}
        priority
        sizes="(min-width: 1024px) 40vw, 340px"
        className="hero-visual-image"
      />

      {/* 3 and 4 — status pills, anchored to the illustration's own margins. */}
      <span className="hero-pill hero-pill--ready">
        <span aria-hidden className="size-2 rounded-pill bg-ready" />
        Ticket ready
      </span>
      <span className="hero-pill hero-pill--live">
        <span aria-hidden className="size-2 rounded-pill bg-preparing" />
        3 tables live
      </span>
    </>
  );

  // Reduced motion: the same composition, perfectly still. The global
  // reduced-motion rule in globals.css also freezes the pill float.
  if (reduceMotion) {
    return (
      <div ref={wrapperRef} className="hero-visual-wrapper">
        {body}
      </div>
    );
  }

  return (
    <motion.div
      ref={wrapperRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{
        y: drift,
        rotateX: interactive ? rotateX : 0,
        rotateY: interactive ? rotateY : 0,
        transformPerspective: 1200,
      }}
      className="hero-visual-wrapper"
    >
      {body}
    </motion.div>
  );
}

/* True only at laptop width (the product's `lg` breakpoint), so the demo-grade
   pointer effects stay off phones and tablets. */
function useIsDesktop() {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setMatches(media.matches);

    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return matches;
}
