import type { Metadata } from "next";
import { FloorView } from "@/components/staff/floor-view";

export const metadata: Metadata = {
  title: "Floor view",
  description: "Live service pacing for every table: pending, preparing, ready and staged carts.",
  robots: { index: false },
};

export default function FloorPage() {
  return <FloorView />;
}
