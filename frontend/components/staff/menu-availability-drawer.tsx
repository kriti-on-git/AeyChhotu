"use client";

import { useMemo, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { useToast } from "@/components/ui/toast";
import { useDb } from "@/hooks/use-db";
import { setMenuItemAvailability } from "@/lib/api";
import type { MenuItem } from "@/lib/api/types";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MenuAvailabilityDrawerProps {
  open: boolean;
  onClose: () => void;
}

/* Shared by the kitchen board and the floor view: one tap marks a dish
   out of stock and it greys out on every live menu at the table. */
export function MenuAvailabilityDrawer({ open, onClose }: MenuAvailabilityDrawerProps) {
  const db = useDb();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byCategory = new Map<string, MenuItem[]>();

    for (const item of db.menu) {
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push(item);
      byCategory.set(item.category, bucket);
    }

    return [...byCategory.entries()];
  }, [db.menu]);

  async function toggle(item: MenuItem) {
    setBusyId(item.id);
    const result = await setMenuItemAvailability(item.id, !item.is_available);
    setBusyId(null);

    if (!result.ok) {
      toast({ title: result.message, tone: "error" });
      return;
    }

    toast({
      title: `${item.name} ${result.data.is_available ? "is back on" : "is 86'd"}`,
      description: result.data.is_available
        ? "Diners can order it again."
        : "It greys out on every menu open right now.",
      tone: result.data.is_available ? "success" : "info",
    });
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="Quick item hide (86)"
      description="Toggling a dish off greys it out instantly on every active menu at the table."
    >
      <div className="flex flex-col gap-7">
        {groups.map(([category, items]) => (
          <section key={category} className="flex flex-col gap-2">
            <h3 className="text-label text-ink-muted uppercase">{category}</h3>

            <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-paper">
              {items.map((item) => {
                const available = item.is_available;

                return (
                  <li key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="flex min-w-0 flex-col">
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          available ? "text-ink" : "text-ink-subtle line-through",
                        )}
                      >
                        {item.name}
                      </span>
                      <span className="text-xs text-ink-muted">{formatPrice(item.price)}</span>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={available}
                      aria-label={`${item.name} availability`}
                      disabled={busyId === item.id}
                      onClick={() => void toggle(item)}
                      className={cn(
                        "relative h-7 w-12 shrink-0 cursor-pointer rounded-pill transition-colors duration-[var(--duration-base)] ease-gentle disabled:opacity-60",
                        available ? "bg-ready" : "bg-sand",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "absolute top-0.5 left-0.5 size-6 rounded-pill bg-paper shadow-sm transition-transform duration-[var(--duration-base)] ease-gentle",
                          available ? "translate-x-5" : "translate-x-0",
                        )}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Drawer>
  );
}
