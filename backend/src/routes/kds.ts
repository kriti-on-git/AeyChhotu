import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createKitchenRouter,
  type KitchenServicePort,
} from "../modules/kitchen/index.js";

/* Module 3 — KDS HTTP shell.

   The Kitchen module now owns E10–E13 and the assistant key. This file keeps
   only the published mount point and the shift gate, so every route stays
   behind requireAuth (401) then requireRole('kitchen') (403) exactly as
   before. */

export interface KdsRouterDeps {
  readonly kitchen: KitchenServicePort;
}

export function createKdsRouter(deps: KdsRouterDeps): Router {
  const router = Router();

  router.use(requireAuth, requireRole("kitchen"));
  router.use(createKitchenRouter({ service: deps.kitchen }));

  return router;
}
