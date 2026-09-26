import type { Transition, Variants } from "motion/react";

/* Motion tokens. Values in seconds keep parity with the CSS
   --duration-* variables declared in app/globals.css. */
export const duration = {
  fast: 0.14,
  base: 0.28,
  slow: 0.52,
  slower: 0.9,
} as const;

export const easeOrganic = [0.22, 1, 0.36, 1] as const;
export const easeGentle = [0.4, 0, 0.2, 1] as const;

export const transitionBase: Transition = {
  duration: duration.base,
  ease: easeOrganic,
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.slow, ease: easeGentle } },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: transitionBase },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: transitionBase },
};

export const slideFromRight: Variants = {
  hidden: { opacity: 0, x: 32 },
  visible: { opacity: 1, x: 0, transition: transitionBase },
};
