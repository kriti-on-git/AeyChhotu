"use client";

import { Clock, EyeOff, Hash, ShieldAlert, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MenuAvailabilityDrawer } from "@/components/staff/menu-availability-drawer";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useNow } from "@/hooks/use-now";
import { usePresence } from "@/hooks/use-presence";
import { useDb } from "@/hooks/use-db";
import { fetchFloorSummaries } from "@/lib/api";
import { countActiveDiners } from "@/lib/api/store";
import type { FloorTableSummary, OrderStatus } from "@/lib/api/types";
import { formatElapsed, formatTableLabel } from "@/lib/format";
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

export function FloorView() {
  const db = useDb();
  const now = useNow(1000);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [summaries, setSummaries] = useState<FloorTableSummary[]>([]);

  usePresence(null);

  useEffect(() => {
    let active = true;

    void fetchFloorSummaries().then((result) => {
      if (active && result.ok) setSummaries(result.data);
    });

    return () => {
      active = false;
    };
  }, [db]);

  const ordered = useMemo(
    () =>
      [...summaries].sort(
        (a, b) => urgency(b) - urgency(a) || a.table.code.localeCompare(b.table.code),
      ),
    [summaries],
  );

  return (
    <main id="main" className="min-h-dvh pb-20">
      <Container className="py-10 sm:py-14">
        <PageHeader
          eyebrow="Floor operations"
          title="Floor view"
          description="Live pacing for every table in the room — no walk to the kitchen pass required."
          actions={
            <Button
              variant="outline"
              onClick={() => setAvailabilityOpen(true)}
              leftIcon={<EyeOff className="size-4" aria-hidden />}
            >
              Quick 86 panel
            </Button>
          }
        />

        {ordered.length === 0 ? (
          <div className="mt-12">
            <EmptyState
              title="No tables are configured"
              description="Tables are seeded for the demo service. Reload the page to restore them."
            />
          </div>
        ) : (
          <ul className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((summary) => (
              <TableCard key={summary.table.id} summary={summary} now={now} db={db} />
            ))}
          </ul>
        )}
      </Container>

      <MenuAvailabilityDrawer open={availabilityOpen} onClose={() => setAvailabilityOpen(false)} />
    </main>
  );
}

function TableCard({
  summary,
  now,
  db,
}: {
  summary: FloorTableSummary;
  now: number | null;
  db: ReturnType<typeof useDb>;
}) {
  const { table, active_order: order, cart_line_count } = summary;
  const status = order?.status ?? null;
  const diners = now === null ? 0 : countActiveDiners(db, table.code, now);

  const allergyLines = order
    ? order.items.filter((item) => item.allergy_note.trim()).length
    : 0;

  const badge = status
    ? statusLabels[status]
    : cart_line_count > 0
      ? { label: "Staged", badge: "outline" as BadgeTone }
      : { label: "Idle", badge: "neutral" as BadgeTone };

  const cardTone = status === "ready" ? "border-ready/55 bg-ready-surface" : undefined;

  const detail = status
    ? guidance[status]
    : cart_line_count > 0
      ? "Items staged in the shared cart but not fired yet."
      : "Nothing in flight for this table.";

  return (
    <li>
      <Card className={cn("h-full", cardTone)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-label text-ink-muted uppercase">{formatTableLabel(table.code)}</span>
            <p className="font-display text-subheading text-ink">{table.name}</p>
          </div>
          <Badge tone={badge.badge} size="md">
            {badge.label}
          </Badge>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
          <span className="flex items-center gap-1.5">
            <Hash className="size-3.5" aria-hidden />
            {table.code}
          </span>

          {order ? (
            <span className="flex items-center gap-1.5">
              <Clock className="size-3.5" aria-hidden />
              {now === null ? "—" : formatElapsed(order.created_at, now)}
            </span>
          ) : (
            <span>{cart_line_count} staged</span>
          )}

          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" aria-hidden />
            {diners === 1 ? "1 phone" : `${diners} phones`}
          </span>

          {allergyLines > 0 ? (
            <span className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-alert">
              <ShieldAlert className="size-3.5" aria-hidden />
              {allergyLines} {allergyLines === 1 ? "allergy" : "allergies"}
            </span>
          ) : null}
        </div>

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
