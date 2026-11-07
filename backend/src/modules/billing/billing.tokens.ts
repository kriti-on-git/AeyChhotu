import { createToken } from "../../bootstrap/Container.js";
import type { BillingServicePort } from "./billing.types.js";

export const BILLING_TOKENS = {
  service: createToken<BillingServicePort>("billing.service"),
} as const;
