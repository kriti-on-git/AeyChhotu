"use client";

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { PointerEvent, ReactNode } from "react";

/* Pointer-tracked 3D tilt: the wrapped object leans toward the cursor and
   springs back to rest on leave — the same feel as the hero cut-out, for
   anything that should read as an object in the room (the kitchen display
   mock, for one). Reduced motion keeps the wrapper a plain div.

   Exists because the landing page is a server component: the pointer
   handlers cannot live there, so this thin client shell carries them. */
export function TiltSurface({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();

  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, { stiffness: 60, damping: 16 });
  const springY = useSpring(pointerY, { stiffness: 60, damping: 16 });
  const rotateY = useTransform(springX, [-0.5, 0.5], [-8, 8]);
  const rotateX = useTransform(springY, [-0.5, 0.5], [6, -6]);

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
  }

  function handlePointerLeave() {
    pointerX.set(0);
    pointerY.set(0);
  }

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{ rotateX, rotateY, transformPerspective: 1200 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
