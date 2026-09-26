import type { Metadata } from "next";
import { DinerTableScreen } from "@/components/diner/diner-table-screen";

export const metadata: Metadata = {
  title: "Table session",
  description: "Add dishes to the shared table cart and fire one grouped order to the kitchen.",
};

export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return <DinerTableScreen tableToken={token} />;
}
