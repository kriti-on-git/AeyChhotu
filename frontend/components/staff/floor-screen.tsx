"use client";

import { FloorView } from "@/components/staff/floor-view";
import { StaffGate } from "@/components/staff/staff-gate";

/* The floor surface: PIN wall → live floor board.

   E17, E14 and the rest of the staff routes need a bearer token, so the floor
   is gated exactly like the kitchen. The storage key differs on purpose —
   locking the kitchen must not leave the floor open, and vice versa. */
export function FloorScreen() {
  return (
    <StaffGate storageKey="aeychhotu.floor.unlocked" surface="floor">
      {({ lock }) => <FloorView onLock={lock} />}
    </StaffGate>
  );
}
