import type { Metadata, Viewport } from "next";
import { KitchenScreen } from "@/components/staff/kitchen-screen";

/* Matches the Ops skin so the browser's own chrome doesn't flash cream
   around the dark console on a wall-mounted tablet. */
export const viewport: Viewport = {
  themeColor: "#14110f",
  colorScheme: "dark",
};

export const metadata: Metadata = {
  title: "Kitchen board",
  description:
    "The kitchen Kanban board: pending, preparing and ready tickets with one-tap status tags.",
  robots: { index: false },
};

export default function KitchenPage() {
  return <KitchenScreen />;
}
