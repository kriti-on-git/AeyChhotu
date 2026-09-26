"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BellRing,
  ChefHat,
  CircleCheck,
  Clock,
  Flame,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActiveDinersBadge } from "@/components/diner/active-diners-badge";
import { InactiveTableState } from "@/components/diner/inactive-table-state";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { useNow } from "@/hooks/use-now";
import { usePresence } from "@/hooks/use-presence";
import { useTableData } from "@/hooks/use-table-data";
import type { Order, OrderStatus } from "@/lib/api/types";
import { formatElapsed, formatTableLabel } from "@/lib/format";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface StatusMeta {
  label: string;
  message: string;
  Icon: LucideIcon;
  circle: string;
  surface: string;
  badge: BadgeTone;
}

const statusMeta: Record<OrderStatus, StatusMeta> = {
  pending: {
    label: "Pending",
    message: "Your ticket is with the kitchen and waiting to start.",
    Icon: Clock,
    circle: "border-pending/45 bg-paper text-pending",
    surface: "bg-surface",
    badge: "pending",
  },
  preparing: {
    label: "Preparing",
    message: "The chef is cooking your table's order right now.",
    Icon: ChefHat,
    circle: "border-preparing/50 bg-paper text-preparing",
    surface: "bg-preparing/10",
    badge: "preparing",
  },
  ready: {
    label: "Ready",
    message: "Your food is ready — it is on its way out to the table.",
    Icon: BellRing,
    circle: "border-ready/50 bg-ready-surface text-ready",
    surface: "bg-ready-surface",
    badge: "ready",
  },
  served: {
    label: "Served",
    message: "Order served. The table can fire a new round whenever it likes.",
    Icon: CircleCheck,
    circle: "border-ready/50 bg-ready-surface text-ready",
    surface: "bg-canvas",
    badge: "ready",
  },
};

const steps: { status: OrderStatus; label: string }[] = [
  { status: "pending", label: "Pending" },
  { status: "preparing", label: "Preparing" },
  { status: "ready", label: "Ready" },
];

const stepIndex: Record<OrderStatus, number> = {
  pending: 0,
  preparing: 1,
  ready: 2,
  served: 3,
};

export interface LiveTrackerProps {
  tableToken: string;
}

export function LiveTracker({ tableToken }: LiveTrackerProps) {
  const { table, cart, orders, totals } = useTableData(tableToken);
  const now = useNow(1000);

  usePresence(tableToken);

  const order = useMemo(
    () =>
      [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).at(0) ?? null,
    [orders],
  );

  const [flashing, setFlashing] = useState(false);
  const previousStatus = useRef<OrderStatus | null>(null);

  useEffect(() => {
    const next = order?.status ?? null;
    const previous = previousStatus.current;
    previousStatus.current = next;

    if (next !== "ready" || previous === next) return;

    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), 4400);
    return () => window.clearTimeout(timer);
  }, [order?.status]);

  if (!table) return <InactiveTableState />;

  const header = (
    <div className="sticky top-0 z-30 border-b border-line/70 bg-cream/85 backdrop-blur-md">
      <Container className="flex flex-wrap items-center justify-between gap-3 py-3.5">
        <div className="flex items-center gap-3">
          <Badge tone="brand">{formatTableLabel(table.code)}</Badge>
          <span className="text-sm text-ink-muted">Live status tracker</span>
        </div>

        <div className="flex items-center gap-3">
          <ActiveDinersBadge tableToken={table.code} />
          <Link
            href={`/table/${table.code}`}
            className={buttonStyles({ variant: "outline", size: "sm" })}
          >
            Back to menu
          </Link>
        </div>
      </Container>
    </div>
  );

  if (!order) {
    return (
      <main id="main" className="min-h-dvh">
        {header}
        <Container size="narrow" className="py-16">
          <EmptyState
            icon={Flame}
            titleAs="h1"
            title={cart.length > 0 ? "Nothing has been fired yet" : "No order is being tracked"}
            description={
              cart.length > 0
                ? `${totals.itemCount} ${
                    totals.itemCount === 1 ? "item is" : "items are"
                  } staged in the shared cart. One tap on review & fire sends them to the kitchen as a single ticket.`
                : "Add dishes to the shared cart and fire them — the live status appears here the moment the kitchen picks the ticket up."
            }
            action={
              <Link href={`/table/${table.code}`} className={buttonStyles({ size: "md" })}>
                Back to the menu
              </Link>
            }
          />
        </Container>
      </main>
    );
  }

  const meta = statusMeta[order.status];
  const firedLabel =
    now === null ? "Fired just now" : `Fired ${formatElapsed(order.created_at, now)} ago`;

  return (
    <main
      id="main"
      className={cn(
        "relative isolate min-h-dvh transition-colors duration-[var(--duration-slower)] ease-gentle",
        meta.surface,
      )}
    >
      {flashing ? (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 animate-flash-ready" />
      ) : null}

      {header}

      <Container size="narrow" className="flex flex-col items-center gap-10 py-12 sm:py-16">
        <div className="flex flex-col items-center gap-4 text-center" aria-live="polite">
          <Text variant="label" tone="subtle">
            {formatTableLabel(table.code)} · status tracker
          </Text>

          <StatusCircle status={order.status} />

          <Heading level="title" as="h1">
            {meta.label}
          </Heading>

          <Text variant="lead" tone="muted" className="max-w-xl">
            {meta.message}
          </Text>
        </div>

        <ProgressSteps status={order.status} />

        <Card tone="canvas" className="w-full">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <div className="flex items-center gap-3">
              <Badge tone={meta.badge}>{meta.label}</Badge>
              <span className="text-sm text-ink-muted">
                {order.items.length} {order.items.length === 1 ? "line" : "lines"} on the ticket
              </span>
            </div>
            <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
              <Clock className="size-3.5" aria-hidden />
              {firedLabel}
            </span>
          </div>

          <ul className="mt-4 flex flex-col gap-3">
            {order.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 border-b border-line/70 pb-3 last:border-0 last:pb-0"
              >
                <p className="flex flex-wrap items-baseline gap-2 text-sm font-medium text-ink">
                  <span className="font-display text-base">{item.quantity}×</span>
                  {item.name}
                  {item.added_by && item.added_by !== "Guest" ? (
                    <span className="text-xs font-normal text-ink-subtle">
                      added by {item.added_by}
                    </span>
                  ) : null}
                </p>

                {item.request_note ? (
                  <p className="text-xs text-ink-muted">Kitchen note: {item.request_note}</p>
                ) : null}

                {item.allergy_note ? (
                  <p className="text-xs font-bold uppercase tracking-wide text-alert">
                    Allergy: {item.allergy_note}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        {cart.length > 0 && order.status !== "served" ? (
          <Card tone="surface" className="w-full">
            <Text variant="small" tone="muted">
              {totals.itemCount} {totals.itemCount === 1 ? "item is" : "items are"} already staged
              for the next round. A second fire is blocked until this order is served.
            </Text>
          </Card>
        ) : null}

        <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href={`/table/${table.code}`}
            className={buttonStyles({
              variant: order.status === "served" ? "primary" : "outline",
              size: "lg",
            })}
          >
            {order.status === "served" ? "Start a new round" : "Back to the menu"}
          </Link>
        </div>
      </Container>
    </main>
  );
}

function StatusCircle({ status }: { status: OrderStatus }) {
  const meta = statusMeta[status];
  const reduceMotion = useReducedMotion();
  const Icon = meta.Icon;

  return (
    <div
      className={cn(
        "relative flex size-40 items-center justify-center rounded-pill border-4 sm:size-48",
        meta.circle,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-3 rounded-pill border border-dashed border-current opacity-30"
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          transition={transitionBase}
          className="flex flex-col items-center gap-1.5"
        >
          <Icon className="size-8" aria-hidden />
          <span className="font-display text-2xl font-semibold">{meta.label}</span>
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

function ProgressSteps({ status }: { status: OrderStatus }) {
  const current = stepIndex[status];
  const complete = status === "served";

  return (
    <ol className="flex w-full items-start gap-2 sm:gap-4" aria-label="Order progress">
      {steps.map((step, index) => {
        const done = complete || index < current;
        const active = !complete && index === current;

        return (
          <li key={step.status} className="flex flex-1 flex-col items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-full rounded-pill transition-colors duration-[var(--duration-base)]",
                done || active ? "bg-dark-brown" : "bg-line",
              )}
            />
            <span
              className={cn(
                "text-label uppercase",
                active ? "text-ink" : done ? "text-ink-muted" : "text-ink-subtle/70",
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
