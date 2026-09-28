"use client";

import { KdsBoard } from "@/components/staff/kds-board";
import { StaffGate } from "@/components/staff/staff-gate";

/* The kitchen surface: PIN wall → live Kanban board. The gate itself lives in
   StaffGate so /floor gets exactly the same guard. */
export function KitchenScreen() {
  return (
    <StaffGate storageKey="aeychhotu.kds.unlocked" surface="kitchen">
      {({ lock }) => <KdsBoard onLock={lock} />}
    </StaffGate>
  );
}
