"use client";

import { KdsBoard } from "@/components/staff/kds-board";
import { StaffGate } from "@/components/staff/staff-gate";

/* The kitchen surface: PIN wall → live Kanban board. The gate itself lives in
   StaffGate so /floor gets exactly the same guard.

   `data-skin="ops"` enlarges the ticket type for a board read standing up,
   at distance, in a bright kitchen. Colour is shared with every other
   surface — the palette is one token set — so only the type scale changes.
   The gate is inside the wrapper on purpose: the PIN wall should match the
   board it unlocks. */
export function KitchenScreen() {
  return (
    <div data-skin="ops" className="min-h-dvh bg-canvas text-ink">
      <StaffGate storageKey="aeychhotu.kds.unlocked" surface="kitchen">
        {({ lock }) => <KdsBoard onLock={lock} />}
      </StaffGate>
    </div>
  );
}
