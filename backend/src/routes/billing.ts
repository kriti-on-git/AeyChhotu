import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createBillingRouter, type BillingServicePort } from "../modules/billing/index.js";
import type { TableServicePort } from "../modules/table/index.js";

/* Additive billing surface. Existing settle route stays where it is; this is
   a staff read/settlement mount for the generated bill. */

const BILLING_ROLES = ["floor", "kitchen", "admin"] as const;

export interface BillingMountDeps {
  readonly service: BillingServicePort;
  /** Optional participant guard. When present, a diner may read only its own
      table's generated bill; every settlement and staff read stays on the
      authenticated staff mount. */
  readonly participants?: Pick<TableServicePort, "authorizeParticipantToken">;
}

export function createBillingMount(deps: BillingMountDeps): Router {
  const router = Router();

  /* Additive guest read. The participant token is validated by Table and the
     principal's table id must equal the path id, so a guest cannot fetch the
     next table's bill by guessing its UUID. */
  router.get("/tables/:table_id/guest", async (req, res) => {
    const raw = req.headers["x-participant-token"];
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!token || !deps.participants) {
      res.status(403).json({
        success: false,
        error: {
          code: "NOT_TABLE_MEMBER",
          message: "This device is not a member of an active table session.",
        },
      });
      return;
    }

    const principal = await deps.participants.authorizeParticipantToken(token);
    if (!principal || principal.table_id !== req.params.table_id) {
      res.status(403).json({
        success: false,
        error: {
          code: "NOT_TABLE_MEMBER",
          message: "This device is not a member of an active table session.",
        },
      });
      return;
    }

    const data = await deps.service.getBill(req.params.table_id);
    res.status(200).json({ success: true, data });
  });

  router.use(requireAuth, requireRole(...BILLING_ROLES));
  router.use(createBillingRouter({ service: deps.service }));
  return router;
}
