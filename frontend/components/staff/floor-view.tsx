"use client";

import { Clock, EyeOff, Lock, ShieldAlert, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MenuAvailabilityDrawer } from "@/components/staff/menu-availability-drawer";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/loading-state";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { useDb } from "@/hooks/use-db";
import { useLiveFloor } from "@/hooks/use-live-floor";
import { useNow } from "@/hooks/use-now";
import { usePresence } from "@/hooks/use-presence";
import { useStaffMenuCatalog } from "@/hooks/use-staff-menu-catalog";
import { countActiveDiners } from "@/lib/api/store";
import type { FloorTableSummary, OrderStatus } from "@/lib/api/types";
import { formatElapsed } from "@/lib/format";
import { cn } from "@/lib/utils";

const statusLabels: Record<OrderStatus, { label: string; badge: BadgeTone }> = {
  pending: { label: "Pending", badge: "pending" },
  preparing: { label: "Preparing", badge: "preparing" },
  ready: { label: "Ready", badge: "ready" },
  served: { label: "Served", badge: "neutral" },
};

const guidance: Record<OrderStatus, string> = {
  pending: "Food awaiting production at the pass.",
  preparing: "On the cooking line right now.",
  ready: "Run the food to the physical table.",
  served: "Order complete.",
};

const statusRail: Record<OrderStatus, string> = {
  pending: "bg-pending",
  preparing: "bg-preparing",
  ready: "bg-ready",
  served: "bg-line-strong",
};

const urgencyRank: Record<OrderStatus, number> = {
  served: 0,
  pending: 2,
  preparing: 3,
  ready: 4,
};

/** Ready tables need a runner first, then cooking, then queued, then staged carts. */
function urgency(summary: FloorTableSummary) {
  const order = summary.active_order;
  if (!order) return summary.cart_line_count > 0 ? 1 : 0;

  return urgencyRank[order.status];
}

export interface FloorViewProps {
  /** Ends the shift — returns the operator to the PIN wall. */
  onLock: () => void;
}

export function FloorView({ onLock }: FloorViewProps) {
  const { phase, error, source, tables, retry } = useLiveFloor();
  const now = useNow(1000);
  const { toast } = useToast();
  const [availabilityOpen, setAvailabilityOpen] = useState(false);

  /* The catalog is global but E3 needs a table token; the floor already knows
     every table code, so hand one over instead of making the hook re-fetch
     the floor list. */
  const catalogToken = tables[0]?.table.code ?? null;
  const catalog = useStaffMenuCatalog(catalogToken);

  // Demo-only: the seeded presence heartbeats keep the phone count alive while
  // the board is offline. Live presence is per-table (channel D) and the floor
  // board spans every table, so it shows cart pressure instead of a count.
  usePresence(null, source === "demo");

  const offlineToastShown = useRef(false);
  useEffect(() => {
    if (phase !== "success" || source !== "demo" || offlineToastShown.current) return;
    offlineToastShown.current = true;
    toast({
      title: "Offline demo floor",
      description: "The backend is unreachable — showing seeded demo tables.",
      tone: "info",
    });
  }, [phase, source, toast]);

  const ordered = useMemo(
    () =>
      [...tables].sort(
        (a, b) => urgency(b) - urgency(a) || a.table.code.localeCompare(b.table.code),
      ),
    [tables],
  );

  return (
    <main id="main" className="min-h-dvh pb-20">
      <Container className="py-10 sm:py-14">
        <PageHeader
          eyebrow="Floor operations"
          title="Floor view"
          description="Live pacing for every table in the room — no walk to the kitchen pass required."
          actions={
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone={source === "demo" ? "outline" : "ready"} size="md">
                {source === "demo" ? "Demo data" : "Live"}
              </Badge>

              <Button
                variant="soft"
                onClick={() => setAvailabilityOpen(true)}
                leftIcon={<EyeOff className="size-4" aria-hidden />}
              >
                Quick 86 panel
              </Button>

              <Button
                variant="ghost"
                onClick={onLock}
                leftIcon={<Lock className="size-4" aria-hidden />}
              >
                Lock board
              </Button>
            </div>
          }
        />

        {/* ---- State matrix: loading ---------------------------------- */}
        {phase === "loading" ? (
          <div className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-44 rounded-lg" />
            ))}
          </div>
        ) : phase === "error" ? (
          /* ---- State matrix: error — API message + Retry -------------- */
          <div className="mt-12">
            <ErrorState
              titleAs="h2"
              title="The floor lost its connection"
              description={error?.message ?? "The floor service could not be reached."}
              action={
                <Button size="md" onClick={retry}>
                  Retry Connection
                </Button>
              }
            />
          </div>
        ) : ordered.length === 0 ? (
          /* ---- State matrix: empty ----------------------------------- */
          <div className="mt-12">
            <EmptyState
              title="No tables are configured"
              description="Add tables in the database and they appear here the moment a diner scans one."
              action={
                <Button variant="outline" size="md" onClick={retry}>
                  Refresh
                </Button>
              }
            />
          </div>
        ) : (
          /* ---- State matrix: success --------------------------------- */
          <ul className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((summary) => (
              <TableCard key={summary.table.id} summary={summary} now={now} demo={source === "demo"} />
            ))}
          </ul>
        )}
      </Container>

      <MenuAvailabilityDrawer
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        menu={catalog.menu}
        onSetAvailability={catalog.setAvailability}
      />
    </main>
  );
}

function TableCard({
  summary,
  now,
  demo,
}: {
  summary: FloorTableSummary;
  now: number | null;
  demo: boolean;
}) {
  const db = useDb();
  const { table, active_order: order, cart_line_count } = summary;
  const status = order?.status ?? null;

  const diners = now === null ? null : countActiveDiners(db, table.code, now);

  /* Allergy lines are the reason this card exists: they come straight from
     E17's `active_order.items`, which is the live join to the ticket. */
  const allergyLines = order
    ? order.items.filter((item) => item.allergy_note.trim()).length
    : 0;

  const badge = status
    ? statusLabels[status]
    : cart_line_count > 0
      ? { label: "Staged", badge: "outline" as BadgeTone }
      : { label: "Idle", badge: "neutral" as BadgeTone };

  const cardTone = status === "ready" ? "border-ready/60 bg-ready-surface" : undefined;

  /* A colour rail on the card edge lets a server triage the whole room by
     scanning the left margin, without reading a single label. */
  const rail = status
    ? statusRail[status]
    : cart_line_count > 0
      ? "bg-line-strong"
      : "bg-line";

  const detail = status
    ? guidance[status]
    : cart_line_count > 0
      ? "Items staged in the shared cart but not fired yet."
      : "Nothing in flight for this table.";

  return (
    <li>
      <Card className={cn("h-full pt-5", cardTone)}>
        <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", rail)} />

        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {/* Staff see the human table name, never the QR token — the
                token is the diner's capability credential. */}
            <span className="text-label text-ink-subtle uppercase">
              Table
            </span>
            <p className="font-display text-subheading text-ink">{table.name}</p>
          </div>
          <Badge tone={badge.badge} size="md">
            {badge.label}
          </Badge>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
          {order ? (
            <span className="flex items-center gap-1.5">
              <Clock className="size-3.5" aria-hidden />
              {now === null ? "—" : formatElapsed(order.created_at, now)}
            </span>
          ) : (
            <span>{cart_line_count} staged</span>
          )}

          {/* Phone count is only meaningful from real presence, which the
              floor board does not subscribe to per table. Showing a seeded
              number next to live orders would be worse than showing none. */}
          {demo && diners !== null ? (
            <span className="flex items-center gap-1.5">
              <Users className="size-3.5" aria-hidden />
              {diners === 1 ? "1 phone" : `${diners} phones`}
            </span>
          ) : null}

        </div>

        {/* Allergies are the reason this card exists, so they get their own
            block rather than a line inside the metadata row. */}
        {allergyLines > 0 ? (
          <p className="mt-3 flex items-center gap-2 rounded-md border border-alert/45 bg-alert-surface px-3 py-2 text-xs font-bold tracking-wide text-alert uppercase">
            <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
            {allergyLines} {allergyLines === 1 ? "allergy" : "allergies"} on this ticket
          </p>
        ) : null}

        <p
          className={cn(
            "mt-4 border-t border-line pt-4 text-sm leading-relaxed",
            status === "ready" ? "font-medium text-ready" : "text-ink-muted",
          )}
        >
          {detail}
        </p>
      </Card>
    </li>
  );
}
