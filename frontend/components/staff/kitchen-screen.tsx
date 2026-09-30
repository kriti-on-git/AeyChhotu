"use client";

import { KdsBoard } from "@/components/staff/kds-board";
import { StaffGate } from "@/components/staff/staff-gate";

/* The kitchen surface: PIN wall → live Kanban board. The gate itself lives in
   StaffGate so /floor gets exactly the same guard.

   `data-skin="ops"` switches the whole subtree onto the dark console token
   set from globals.css — the board is read standing up, at distance, in a
   bright kitchen, which is a different problem from a diner reading a menu
   in their hand. The gate is inside the wrapper on purpose: the PIN wall
   should match the board it unlocks. */
export function KitchenScreen() {
  return (
    <div data-skin="ops" className="min-h-dvh bg-canvas text-ink">
      <StaffGate storageKey="aeychhotu.kds.unlocked" surface="kitchen">
        {({ lock }) => <KdsBoard onLock={lock} />}
      </StaffGate>
    </div>
  );
}
