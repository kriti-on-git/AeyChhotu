/* Billing module — internal domain facts. */

import type { BillingEventPublisher } from "./billing.types.js";

export const BILLING_EVENTS = {
  settled: "bill.settled",
} as const;

/** Used by the compatibility seam, where no bus is composed. */
export const NOOP_BILLING_EVENTS: BillingEventPublisher = {
  billSettled: () => undefined,
};
