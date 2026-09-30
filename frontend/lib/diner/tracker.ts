/* Tracker delight — the presentational layer of the live order tracker.

   None of this talks to the backend and none of it changes the order's real
   status, which always comes from the kitchen. The arrival estimate is a
   demo-only guess built from data the screen already holds (this table's open
   tickets and the lines on them), and the activity line and the foodie joke
   rotate on a timer purely so a live demo feels alive. Everything here is
   read-only copy. */

import type { Order, OrderStatus } from "@/lib/api/types";

/* Eight clean, family-friendly lines. Kept short so the joke never competes
   with the status above it. */
export const FOODIE_JOKES: string[] = [
  "Why did the dosa cross the table? Because it wanted to get to the other side.",
  "Our chef doesn't believe in fast food. Only fast disappearing food.",
  "Calories don't count when someone else ordered dessert.",
  "The biryani said it was layered. We believed it.",
  "We asked the naan to relax. It said it was already well-buttered.",
  "Good food takes time. Great food takes slightly longer.",
  "Your order is coming. Your hunger has been notified.",
  "The only thing being served faster than your food is this joke.",
];

/* Quiet micro-status lines, one pool per real status so the copy can never
   contradict the kitchen. Rotated by the tracker every few seconds. */
export const ACTIVITY_LINES: Record<OrderStatus, string[]> = {
  pending: [
    "Your ticket is in the queue at the pass.",
    "The kitchen is working through the tickets ahead of you.",
    "The line has your order and is starting it next.",
  ],
  preparing: [
    "Chef is on your order right now.",
    "The line is finishing the final item.",
    "Your dishes are being plated at the pass.",
  ],
  ready: [
    "Your order has left the pass.",
    "Everything is plated and heading to the table.",
    "A runner has picked up your ticket.",
  ],
  served: [
    "Enjoy — that round is on the table.",
    "Served. Fire another round whenever you like.",
  ],
};

export interface ArrivalEstimate {
  /** Predicted minutes until the food reaches the table. */
  minutes: number;
  /** Active tickets the estimate is "based on" (this table + a mock ambient). */
  tickets: number;
  /** Quantity of dishes still in flight. */
  items: number;
}

const BASE_MINUTES = 2;
const MIN_MINUTES = 4;
const MAX_MINUTES = 40;

/* Small deterministic hash so the demo's ambient ticket count is stable for a
   given order instead of flickering on every render. */
function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/* Demo-only: base preparation time + one minute per dish + two minutes per
   open ticket. A diner can only see this table's tickets, so a small ambient
   count stands in for the rest of the room. It is not a real kitchen
   algorithm — it only has to feel intelligent and move with the order. */
export function estimateArrival(orders: Order[]): ArrivalEstimate {
  const active = orders.filter((order) => order.status !== "served");
  const items = active.reduce(
    (total, order) => total + order.items.reduce((sum, item) => sum + item.quantity, 0),
    0,
  );
  const ambient = hash(active[0]?.id ?? "") % 2;
  const tickets = active.length + ambient;

  return {
    minutes: clamp(BASE_MINUTES + items + tickets * 2, MIN_MINUTES, MAX_MINUTES),
    tickets,
    items,
  };
}
