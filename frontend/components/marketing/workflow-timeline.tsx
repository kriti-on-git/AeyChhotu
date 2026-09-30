"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface WorkflowStep {
  title: string;
  body: string;
}

/* The five stages used to be a static list with a dead hairline between them.
   Now the rail fills under a travelling highlight: the step advances on its
   own every few seconds, stops while a reader is inspecting it, and can be
   driven directly by clicking a number. */
export function WorkflowTimeline({ steps }: { steps: WorkflowStep[] }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion || paused) return;

    const timer = window.setInterval(
      () => setActive((current) => (current + 1) % steps.length),
      2600,
    );
    return () => window.clearInterval(timer);
  }, [reduceMotion, paused, steps.length]);

  const progress = steps.length > 1 ? (active / (steps.length - 1)) * 100 : 0;

  return (
    <ol
      className="relative grid gap-8 lg:grid-cols-5 lg:gap-5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Two hairlines: the track, and the ember fill that travels along it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-5 right-0 left-0 hidden h-0.5 bg-line lg:block"
      />
      <motion.span
        aria-hidden
        className="pointer-events-none absolute top-5 left-0 hidden h-0.5 bg-ember lg:block"
        initial={false}
        animate={{ width: `${progress}%` }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />

      {steps.map((step, index) => {
        const isActive = index === active;
        const isDone = index < active;

        return (
          <li key={step.title} className="relative">
            <button
              type="button"
              onClick={() => setActive(index)}
              aria-current={isActive ? "step" : undefined}
              className="group flex w-full cursor-pointer flex-col items-start gap-4 text-left lg:items-center lg:text-center"
            >
              <span
                className={cn(
                  "relative z-10 grid size-10 shrink-0 place-items-center rounded-pill font-display text-sm font-semibold",
                  "transition-[transform,background-color,color,box-shadow] duration-[var(--duration-base)] ease-organic",
                  isActive
                    ? "scale-110 bg-ember text-on-ember shadow-md"
                    : isDone
                      ? "bg-ember-soft text-ember"
                      : "bg-sand text-ink-subtle group-hover:bg-ember-soft group-hover:text-ember",
                )}
              >
                {index + 1}

                {isActive ? (
                  <span
                    aria-hidden
                    className="animate-pulse-soft absolute -inset-1.5 rounded-pill border border-ember/40"
                  />
                ) : null}
              </span>

              <span className="flex flex-col lg:items-center">
                <span
                  className={cn(
                    "font-display text-base font-semibold transition-colors duration-[var(--duration-base)]",
                    isActive ? "text-ink" : "text-ink-muted",
                  )}
                >
                  {step.title}
                </span>
                <span
                  className={cn(
                    "mt-1.5 text-sm leading-relaxed transition-opacity duration-[var(--duration-base)]",
                    isActive ? "text-ink-muted opacity-100" : "text-ink-subtle opacity-70",
                  )}
                >
                  {step.body}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
