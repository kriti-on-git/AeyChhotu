"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { duration, easeOrganic } from "@/lib/motion";

export interface RevealProps {
  children: ReactNode;
  /** Seconds of delay, used to stagger siblings. */
  delay?: number;
  className?: string;
}

export function Reveal({ children, delay = 0, className }: RevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: duration.slow, ease: easeOrganic, delay }}
    >
      {children}
    </motion.div>
  );
}
