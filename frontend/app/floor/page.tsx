import type { Metadata, Viewport } from "next";
import { FloorScreen } from "@/components/staff/floor-screen";

export const viewport: Viewport = {
  themeColor: "#fbf8f4",
  colorScheme: "light",
};

export const metadata: Metadata = {
  title: "Floor view",
  description: "Live service pacing for every table: pending, preparing, ready and staged carts.",
  robots: { index: false },
};

export default function FloorPage() {
  return <FloorScreen />;
}
