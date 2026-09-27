"use client";

import { AnimatePresence } from "motion/react";
import { BellRing, ChefHat, EyeOff, Flame, Lock, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { KdsCard } from "@/components/staff/kds-card";
import { MenuAvailabilityDrawer } from "@/components/staff/menu-availability-drawer";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { usePresence } from "@/hooks/use-presence";
import { useLiveKds } from "@/hooks/use-live-kds";
import { activateShift } from "@/lib/api-client";
import { getDeviceId } from "@/lib/api/session";
import type { Order, OrderStatus } from "@/lib/api/types";
import { armAudio, isAudioArmed, playChime } from "@/lib/sound";
import { cn } from "@/lib/utils";

type ColumnStatus = Exclude<OrderStatus, "served">;

interface Column {
  status: ColumnStatus;
  title: string;
  hint: string;
  dot: string;
  badge: BadgeTone;
  icon: typeof Flame;
  empty: string;
}

const columns: Column[] = [
  {
    status: "pending",
    title: "Pending",
    hint: "Waiting to start",
    dot: "bg-pending",
    badge: "pending",
    icon: Flame,
    empty: "No tickets waiting",
  },
  {
    status: "preparing",
    title: "Preparing",
    hint: "On the line",
    dot: "bg-preparing",
    badge: "preparing",
    icon: ChefHat,
    empty: "Nothing is cooking",
  },
  {
    status: "ready",
    title: "Ready",
    hint: "At the pass",
    dot: "bg-ready",
    badge: "ready",
    icon: BellRing,
    empty: "Nothing at the pass",
  },
];

export interface KdsBoardProps {
  onLock: () => void;
}

export function KdsBoard({ onLock }: KdsBoardProps) {
  const { phase, error, source, tickets, busy, retry, refresh, advance } = useLiveKds();
  const now = useNow(1000);
  const { toast } = useToast();
  const [audioArmed, setAudioArmed] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);

  usePresence(null);

  // Offline fallback heads-up: one toast so the operator knows the board
  // is serving seeded demo data instead of the live kitchen.
  const demoToastShown = useRef(false);
  useEffect(() => {
    if (phase !== "success" || source !== "demo" || demoToastShown.current) return;
    demoToastShown.current = true;
    toast({
      title: "Offline demo board",
      description: "The backend is unreachable — showing the seeded demo tickets.",
      tone: "info",
    });
  }, [phase, source, toast]);

  const knownTickets = useRef<Set<string> | null>(null);
  if (knownTickets.current === null) {
    knownTickets.current = new Set(tickets.map((order) => order.id));
  }

  // Realtime B (`kds_orders` INSERT) lands as a refreshed ticket list —
  // the diff below drives the chime + arrival toast without a page reload.
  useEffect(() => {
    const known = knownTickets.current;
    if (!known) return;

    const arriving = tickets.filter((order) => !known.has(order.id));
    const first = arriving[0];
    if (!first) return;

    for (const order of arriving) known.add(order.id);
    if (!audioArmed || !isAudioArmed()) return;

    playChime();
    toast({
      title: `New ticket · Table ${first.table_code}`,
      description: `${arriving.reduce((total, order) => total + order.items.length, 0)} lines just landed in Pending.`,
    });
  }, [tickets, audioArmed, toast]);

  function handleStartShift() {
    const armed = armAudio();
    setAudioArmed(armed);

    // E13 — register this device for shift chimes (no-op when offline).
    void activateShift(getDeviceId()).catch(() => undefined);

    toast({
      title: armed ? "Audio armed" : "Audio blocked",
      description: armed
        ? "The board will ping every time a table fires an order."
        : "This browser blocked the audio context — the board still updates visually.",
      tone: armed ? "success" : "error",
    });
  }

  async function handleAdvance(order: Order, next: OrderStatus) {
    // One-tap mutation guardrail: the hook's per-ticket busy map blocks the
    // second tap, and the card renders the button in its spinner state.
    const result = await advance(order, next);

    if (!result.ok) {
      toast({ title: result.message ?? "Could not update that ticket.", tone: "error" });
      return;
    }

    if (next === "served") {
      toast({
        title: `Table ${order.table_code} served`,
        description: "The ticket has been pruned from the board.",
        tone: "success",
      });
    } else {
      toast({
        title: `Table ${order.table_code} → ${next === "preparing" ? "Preparing" : "Ready"}`,
        description: "The table's live tracker updated instantly.",
        tone: "success",
      });
    }
  }

  const boardEmpty = tickets.length === 0;

  return (
    <main id="main" className="min-h-dvh pb-16">
      <header className="sticky top-0 z-30 border-b border-line bg-cream/90 backdrop-blur-md">
        <Container className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3">
            <Badge tone="brand" size="md">
              Kitchen
            </Badge>
            <div className="flex flex-col">
              <h1 className="font-display text-subheading text-ink">Kitchen display</h1>
              <p className="text-xs text-ink-muted">
                {phase === "loading"
                  ? "Loading the line…"
                  : tickets.length === 1
                    ? "1 live ticket"
                    : `${tickets.length} live tickets`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={audioArmed ? "secondary" : "primary"}
              size="md"
              onClick={handleStartShift}
              leftIcon={<Volume2 className="size-4" aria-hidden />}
            >
              {audioArmed ? "Audio on" : "Start shift & enable audio"}
            </Button>

            <Button
              variant="outline"
              size="md"
              onClick={() => setAvailabilityOpen(true)}
              leftIcon={<EyeOff className="size-4" aria-hidden />}
            >
              Manage 86
            </Button>

            <Button
              variant="ghost"
              size="md"
              onClick={onLock}
              leftIcon={<Lock className="size-4" aria-hidden />}
            >
              Lock board
            </Button>
          </div>
        </Container>
      </header>

      {/* ---- State matrix: error — API message + Retry Connection --------- */}
      {phase === "error" ? (
        <Container size="narrow" className="py-16">
          <ErrorState
            titleAs="h1"
            title="The board lost its connection"
            description={error?.message ?? "The kitchen line could not be reached."}
            action={
              <Button size="md" onClick={retry}>
                Retry Connection
              </Button>
            }
          />
        </Container>
      ) : (
        <Container className="grid gap-5 py-6 lg:grid-cols-3">
          {columns.map((column) => {
            const list = tickets.filter((order) => order.status === column.status);

            return (
              <section
                key={column.status}
                aria-label={`${column.title} tickets`}
                className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5"
              >
                <header className="flex items-center justify-between gap-3 border-b border-line pb-3">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden className={cn("size-2.5 rounded-pill", column.dot)} />
                    <h2 className="font-display text-subheading text-ink">{column.title}</h2>
                  </span>

                  <span className="flex items-center gap-2">
                    <span className="text-xs text-ink-subtle">{column.hint}</span>
                    <Badge tone={column.badge}>{list.length}</Badge>
                  </span>
                </header>

                {/* ---- State matrix: loading — column skeletons ------------ */}
                {phase === "loading" ? (
                  <ul className="flex flex-col gap-4" aria-hidden>
                    {[0, 1].map((row) => (
                      <li
                        key={row}
                        className="flex flex-col gap-4 rounded-lg border border-line bg-paper p-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Skeleton className="h-6 w-24 rounded-pill" />
                          <Skeleton className="h-3 w-12" />
                        </div>
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-10 w-full rounded-md" />
                      </li>
                    ))}
                  </ul>
                ) : list.length === 0 ? (
                  /* ---- State matrix: empty — contextual copy + CTA ------- */
                  <EmptyState
                    icon={column.icon}
                    title={column.empty}
                    description={
                      boardEmpty
                        ? "No active orders on the line! 🍳 The board pings the moment a table fires."
                        : "Tickets move here the moment a status tag is tapped."
                    }
                    className="py-8"
                    action={
                      boardEmpty ? (
                        <Button variant="outline" size="sm" onClick={() => void refresh()}>
                          Check again
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  /* ---- State matrix: success — interactive grid ---------- */
                  <ul className="flex flex-col gap-4">
                    <AnimatePresence initial={false}>
                      {list.map((order) => (
                        <KdsCard
                          key={order.id}
                          order={order}
                          now={now}
                          busy={Boolean(busy[order.id])}
                          onAdvance={(ticket, next) => void handleAdvance(ticket, next)}
                        />
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
              </section>
            );
          })}
        </Container>
      )}

      <MenuAvailabilityDrawer open={availabilityOpen} onClose={() => setAvailabilityOpen(false)} />
    </main>
  );
}
