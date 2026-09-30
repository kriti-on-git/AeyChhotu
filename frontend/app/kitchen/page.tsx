import type { Metadata, Viewport } from "next";
import { KitchenScreen } from "@/components/staff/kitchen-screen";

/* The board shares the light Hospitality palette with every other surface,
   so the browser's own chrome matches the document. */
export const viewport: Viewport = {
  themeColor: "#fbf8f4",
  colorScheme: "light",
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
