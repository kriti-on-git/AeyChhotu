"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Clock, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Order, OrderStatus } from "@/lib/api/types";
import { formatElapsed } from "@/lib/format";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface AdvanceAction {
  label: string;
  variant: "ember" | "primary" | "secondary";
  next: OrderStatus;
}

const actions: Record<Exclude<OrderStatus, "served">, AdvanceAction> = {
  pending: { label: "Cook", variant: "ember", next: "preparing" },
  preparing: { label: "Ready", variant: "primary", next: "ready" },
  ready: { label: "Mark served", variant: "secondary", next: "served" },
};

export interface KdsCardProps {
  order: Order;
  now: number | null;
  onAdvance: (order: Order, next: OrderStatus) => void;
}

export function KdsCard({ order, now, onAdvance }: KdsCardProps) {
  const reduceMotion = useReducedMotion();
  const action = order.status === "served" ? null : actions[order.status];

  if (!action) return null;

  return (
    <motion.li
      layout
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={transitionBase}
      className="flex flex-col gap-4 rounded-lg border border-line bg-paper p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="brand" size="md">
          Table {order.table_code}
        </Badge>
        <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
          <Clock className="size-3.5" aria-hidden />
          {now === null ? "—" : formatElapsed(order.created_at, now)}
        </span>
      </header>

      <ul className="flex flex-col gap-3">
        {order.items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1">
            <p className="flex flex-wrap items-baseline gap-2 text-sm font-medium text-ink">
              <span className="font-display text-base">{item.quantity}×</span>
              {item.name}
            </p>

            {item.added_by && item.added_by !== "Guest" ? (
              <p className="text-xs text-ink-subtle">{item.added_by}</p>
            ) : null}

            {item.request_note ? (
              <p className="text-xs leading-relaxed text-ink-muted">Note: {item.request_note}</p>
            ) : null}

            {item.allergy_note ? (
              <p
                className={cn(
                  "mt-1 flex items-start gap-2 rounded-md border-2 border-alert/40 bg-alert-surface px-2.5 py-2",
                  "text-sm font-bold uppercase leading-snug tracking-wide text-alert",
                )}
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>Allergy · {item.allergy_note}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <Button
        variant={action.variant}
        fullWidth
        onClick={() => onAdvance(order, action.next)}
        rightIcon={<ArrowRight className="size-4" aria-hidden />}
      >
        {action.label}
      </Button>
    </motion.li>
  );
}
