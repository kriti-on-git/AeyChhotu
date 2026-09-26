"use client";

import { Users } from "lucide-react";
import { countActiveDiners } from "@/lib/api/store";
import { useDb } from "@/hooks/use-db";
import { useNow } from "@/hooks/use-now";
import { Badge } from "@/components/ui/badge";

export interface ActiveDinersBadgeProps {
  tableToken: string;
}

export function ActiveDinersBadge({ tableToken }: ActiveDinersBadgeProps) {
  const db = useDb();
  const now = useNow(5000);

  if (now === null) {
    return (
      <Badge tone="neutral" className="gap-1.5">
        <Users className="size-3.5" aria-hidden />
        Syncing
      </Badge>
    );
  }

  const count = countActiveDiners(db, tableToken, now);

  return (
    <Badge tone="neutral" className="gap-1.5">
      <Users className="size-3.5" aria-hidden />
      {count === 1 ? "1 phone live" : `${count} phones live`}
    </Badge>
  );
}
