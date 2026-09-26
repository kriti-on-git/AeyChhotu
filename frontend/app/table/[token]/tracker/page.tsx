import type { Metadata } from "next";
import { LiveTracker } from "@/components/diner/live-tracker";

export const metadata: Metadata = {
  title: "Live order tracker",
  description:
    "Watch the kitchen move this table's order from pending to preparing to ready, live.",
};

export default async function TrackerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return <LiveTracker tableToken={token} />;
}
