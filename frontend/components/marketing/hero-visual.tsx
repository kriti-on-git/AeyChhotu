"use client";

import Image from "next/image";
import { useRef, type PointerEvent } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

/* ---------------------------------------------------------------
   Hero visual: ONE composition.

   .hero-visual-wrapper holds four things and nothing else — the
   ambient light layer, the cut-out server, and the two status pills.
   The pills are absolutely positioned against the wrapper, not the
   page, so they orbit the illustration and cannot drift into the
   headline at any width.

   The lighting rule this file exists to keep: the pointer moves the
   GLOW LAYER, never the artwork. The image carries no shadow, no
   filter and no glow — a box-shaped treatment on a PNG is visible as
   a rectangle around the subject, and the source art is a wide canvas
   with a narrow figure inside it, so that rectangle would sit a long
   way from anything you can actually see. The crop that makes the
   wrapper hug the figure, and the reasoning behind it, live in
   app/globals.css next to the classes.

   Interaction cost: one pointer handler that writes two numbers onto
   the wrapper as CSS custom properties. No React state, so no
   re-render; no animation loop either, because .hero-glow eases into
   whatever it is handed with a transition of its own. Moving away
   writes the resting values back and the light settles there.
   --------------------------------------------------------------- */

export function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

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
    if (reduceMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointGlowAt(
      ((event.clientX - rect.left) / rect.width - 0.5) * 2,
      ((event.clientY - rect.top) / rect.height - 0.5) * 2,
    );
  }

  function handlePointerLeave() {
    if (reduceMotion) return;
    pointGlowAt(0, 0);
  }

  // A gentle vertical drift across the hero's scroll-through. No rotation:
  // the composition should read as one object, not as a card being tilted.
  const { scrollY } = useScroll();
  const drift = useTransform(scrollY, [0, 900], [0, 48]);

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
      style={{ y: drift }}
      className="hero-visual-wrapper"
    >
      {body}
    </motion.div>
  );
}
