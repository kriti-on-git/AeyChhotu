import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createBillingRouter, type BillingServicePort } from "../modules/billing/index.js";

/* Additive billing surface. Existing settle route stays where it is; this is
   a staff read/settlement mount for the generated bill. */

const BILLING_ROLES = ["floor", "kitchen", "admin"] as const;

export interface BillingMountDeps {
  readonly service: BillingServicePort;
}

export function createBillingMount(deps: BillingMountDeps): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...BILLING_ROLES));
  router.use(createBillingRouter({ service: deps.service }));
  return router;
}
