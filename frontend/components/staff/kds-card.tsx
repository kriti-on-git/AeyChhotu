"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Clock, TriangleAlert } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Order, OrderStatus } from "@/lib/api/types";
import { formatElapsed } from "@/lib/format";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface AdvanceAction {
  label: string;
  variant: "ember" | "primary" | "soft";
  next: OrderStatus;
}

const actions: Record<Exclude<OrderStatus, "served">, AdvanceAction> = {
  pending: { label: "Start cooking", variant: "ember", next: "preparing" },
  preparing: { label: "Mark ready", variant: "ember", next: "ready" },
  ready: { label: "Mark served", variant: "soft", next: "served" },
};

const statusTone: Record<Exclude<OrderStatus, "served">, BadgeTone> = {
  pending: "pending",
  preparing: "preparing",
  ready: "ready",
};

const statusRail: Record<Exclude<OrderStatus, "served">, string> = {
  pending: "bg-pending",
  preparing: "bg-preparing",
  ready: "bg-ready",
};

/* Time-on-ticket is the one number a chef scans for, so it escalates through
   the status colours rather than sitting in flat grey. */
function elapsedClass(minutes: number) {
  if (minutes >= 12) return "bg-alert-surface text-alert";
  if (minutes >= 6) return "bg-preparing-surface text-preparing";
  return "bg-sand text-ink-muted";
}

export interface KdsCardProps {
  order: Order;
  now: number | null;
  /** True while this card's one-tap advance is in flight — locks the
      button so a double-tap can't fire a duplicate status mutation. */
  busy?: boolean;
  onAdvance: (order: Order, next: OrderStatus) => void;
}

export function KdsCard({ order, now, busy = false, onAdvance }: KdsCardProps) {
  const reduceMotion = useReducedMotion();
  // Narrowed once into a local: `order.status` is a property access, so
  // TypeScript cannot carry the `served` exclusion through to later reads.
  const status = order.status;

  if (status === "served") return null;

  const action = actions[status];

  const createdAt = new Date(order.created_at).getTime();
  const minutes = now === null ? 0 : Math.max(0, Math.floor((now - createdAt) / 60_000));

  return (
    <motion.li
      layout
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={transitionBase}
      className="relative overflow-hidden rounded-lg border border-line-strong bg-paper shadow-md"
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1.5", statusRail[status])} />

      <div className="flex flex-col gap-4 p-4 pl-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="font-display text-xl leading-none font-semibold text-ink">
              Table {order.table_code}
            </p>
            <span
              className={cn(
                "inline-flex w-fit items-center gap-1.5 rounded-pill px-2 py-1 text-xs font-semibold tabular-nums",
                elapsedClass(minutes),
              )}
            >
              <Clock className="size-3.5" aria-hidden />
              {now === null ? "—" : formatElapsed(order.created_at, now)}
            </span>
          </div>

          <Badge tone={statusTone[status]} size="md">
            {status}
          </Badge>
        </header>

        <ul className="flex flex-col gap-3 border-t border-line pt-4">
          {order.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1.5">
              <p className="flex flex-wrap items-baseline gap-2 text-base font-medium text-ink">
                <span className="font-display text-lg font-semibold tabular-nums">
                  {item.quantity}×
                </span>
                {item.name}
              </p>

              {item.added_by && item.added_by !== "Guest" ? (
                <p className="text-xs text-ink-subtle">{item.added_by}</p>
              ) : null}

              {item.request_note ? (
                <p className="text-sm leading-relaxed text-ink-muted">
                  Note: {item.request_note}
                </p>
              ) : null}

              {item.allergy_note ? (
                <p
                  className={cn(
                    "mt-1 flex items-start gap-2 rounded-md border-2 border-alert/50 bg-alert-surface px-3 py-2",
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
          size="lg"
          fullWidth
          className="h-14 text-base"
          disabled={busy}
          loading={busy}
          onClick={() => {
            if (busy) return;
            onAdvance(order, action.next);
          }}
          rightIcon={busy ? undefined : <ArrowRight className="size-5" aria-hidden />}
        >
          {busy ? "Working…" : action.label}
        </Button>
      </div>
    </motion.li>
  );
}
