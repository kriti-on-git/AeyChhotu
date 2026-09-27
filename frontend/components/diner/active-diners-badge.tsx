"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { countActiveDiners } from "@/lib/api/store";
import { getDeviceId } from "@/lib/api/session";
import { useDb } from "@/hooks/use-db";
import { useNow } from "@/hooks/use-now";
import { Badge } from "@/components/ui/badge";
import { getSupabase, trackTablePresence } from "@/lib/api-client";

export interface ActiveDinersBadgeProps {
  tableToken: string;
}

export function ActiveDinersBadge({ tableToken }: ActiveDinersBadgeProps) {
  const db = useDb();
  const now = useNow(5000);
  const [presenceCount, setPresenceCount] = useState<number | null>(null);

  // Live first: realtime channel D (`table_presence:{token}`) counts the
  // devices joined to the room; falls back to demo heartbeats below when
  // Supabase realtime isn't configured.
  const live = getSupabase() !== null;

  useEffect(() => {
    if (!live) return;
    return trackTablePresence(tableToken, getDeviceId(), setPresenceCount);
  }, [live, tableToken]);

  if (live) {
    return (
      <Badge tone="neutral" className="gap-1.5">
        <Users className="size-3.5" aria-hidden />
        {presenceCount === null
          ? "Syncing"
          : presenceCount === 1
            ? "1 phone live"
            : `${presenceCount} phones live`}
      </Badge>
    );
  }

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
