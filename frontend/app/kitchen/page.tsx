import type { Metadata } from "next";
import { KitchenScreen } from "@/components/staff/kitchen-screen";

export const metadata: Metadata = {
  title: "Kitchen board",
  description:
    "The kitchen Kanban board: pending, preparing and ready tickets with one-tap status tags.",
  robots: { index: false },
};

export default function KitchenPage() {
  return <KitchenScreen />;
}
