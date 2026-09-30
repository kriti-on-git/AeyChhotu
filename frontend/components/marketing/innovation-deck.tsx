"use client";

import { Activity, ArrowRight, ShieldAlert, ShoppingBasket, type LucideIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Innovation {
  title: string;
  innovation: string;
  impact: string;
  icon: LucideIcon;
}

const innovations: Innovation[] = [
  {
    title: "The anti-chaos unified cart",
    innovation:
      "Every phone at a table shares one live-syncing room bucket instead of being treated as an independent customer.",
    impact:
      "A digital gatekeeper: the kitchen never receives eight tickets for one table, and course timing is protected without a server merging orders by hand.",
    icon: ShoppingBasket,
  },
  {
    title: "Guardrailed allergy alerts",
    innovation:
      "Dietary notes bypass the standard modifier log and are formatted as bold, high-contrast red directly on the kitchen ticket line.",
    impact:
      "Removes the human error of handwriting and forgotten verbal warnings — chefs see the safety risk without stopping the line.",
    icon: ShieldAlert,
  },
  {
    title: "Two-way micro-status",
    innovation:
      "Prep milestones stream outward: Pending, Preparing, Ready. No static done / not done checkbox.",
    impact:
      "Guests lose waiting anxiety and servers stop running to the kitchen window to ask how long the steaks will be.",
    icon: Activity,
  },
];

/* A deck, not a grid: only the front card is readable and actionable. Every
   card shares one grid cell so the cell height tracks the tallest card, and
   the front card's Okay button sends it to the back of the stack, revealing
   the next one. `order` holds the card indices front-to-back. */
export function InnovationDeck() {
  const [order, setOrder] = useState<number[]>(() => innovations.map((_, index) => index));
  const reduceMotion = useReducedMotion();

  function advance() {
    setOrder((previous) => {
      const [front, ...rest] = previous;
      return front === undefined ? previous : [...rest, front];
    });
  }

  return (
    <div className="relative grid pb-14">
      {order.map((index, position) => {
        const item = innovations[index];
        if (!item) return null;

        const isFront = position === 0;

        return (
          <motion.article
            key={item.title}
            initial={false}
            animate={{ y: position * 20, scale: 1 - position * 0.045 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 240, damping: 28, mass: 0.9 }
            }
            style={{ zIndex: innovations.length - position }}
            aria-hidden={!isFront}
            className={cn(
              "col-start-1 row-start-1 flex flex-col rounded-xl border p-6 backdrop-blur-sm",
              isFront
                ? "border-ember/45 bg-ink-inverse/10 shadow-lg"
                : "pointer-events-none border-ink-inverse/15 bg-ink-inverse/5",
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-md bg-ember text-on-ember">
              <item.icon className="size-5" aria-hidden />
            </span>

            <h3 className="mt-5 font-display text-subheading text-ink-inverse">{item.title}</h3>

            <p className="mt-3 text-sm leading-relaxed text-ink-inverse/80">{item.innovation}</p>

            <p className="mt-5 border-t border-ink-inverse/15 pt-5 text-sm leading-relaxed text-ink-inverse/65">
              {item.impact}
            </p>

            {isFront ? (
              <div className="mt-auto flex items-center justify-between gap-4 border-t border-ink-inverse/15 pt-5">
                <span className="text-label text-ink-inverse/55 uppercase tabular-nums">
                  {index + 1} / {innovations.length}
                </span>
                <Button
                  variant="ember"
                  size="md"
                  onClick={advance}
                  aria-label="Okay, show the next idea"
                  rightIcon={<ArrowRight className="size-4" aria-hidden />}
                >
                  Okay
                </Button>
              </div>
            ) : null}
          </motion.article>
        );
      })}
    </div>
  );
}
